/**
 * Live preview: a pure decoration builder over the syntax tree + wiki-link
 * grammar. The ELEMENT the selection touches renders RAW (no concealing
 * decorations on it); everything else renders, including the rest of its own
 * line. Rebuilds on docChanged/selectionSet/viewport — a plain recompute.
 *
 * D91, which narrows D22. D22 revealed whole LINES, so a caret anywhere on a
 * line stripped every chip, image and pair of `**` on it back to source at once.
 * The unit is now the element, and `revealedSpans` below is the whole of the new
 * rule: touched edges included, innermost only.
 */
import { syntaxTree } from '@codemirror/language'
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

/** A range in the document. The unit live preview reveals, and the unit D91
 *  replaced D22's whole line with. */
export interface Span {
  from: number
  to: number
}

/** Spans are compared by value, never by identity: they are built twice, once
 *  to decide what the caret is on and once to decorate. */
export function spanKey(span: Span): string {
  return `${span.from}:${span.to}`
}

/**
 * Does the selection touch this span? EDGE-INCLUSIVE, deliberately.
 *
 * A caret resting at either end counts as being on the element, so the `**` you
 * have just finished typing stay on screen until you move off the word. Excluding
 * the edges would close them the instant you type the second one and shift the
 * rest of the line four characters left under your fingers.
 */
export function touches(sel: Span, span: Span): boolean {
  return sel.from <= span.to && sel.to >= span.from
}

/**
 * Of the spans the selection touches, the ones with nothing smaller inside them.
 *
 * This is what "the element the caret is on" means once elements nest.
 * `**bold with [[a link]] inside**` is two spans, and with the caret on the link
 * only the link comes back raw: you are not on the bold, you are on the thing
 * inside it. Containment is the whole rule, and it is STRICT, so two elements
 * that happen to share a range do not cancel each other out.
 *
 * Pure, and on numbers — the spans come from the tree in the caller.
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
 *
 * Usually the element itself. The exceptions are the marks that belong to a LINE
 * rather than to a word — a heading's `#` and a list item's marker — because
 * scoping those to the two columns they occupy would mean the caret had to land
 * on the marker itself before you could edit the heading, which is not what "the
 * heading you are on" means to anybody.
 *
 * `null` for everything live preview does not conceal conditionally: fenced code,
 * quote marks, the frontmatter block, a list's leading indent.
 */
function revealSpan(state: EditorState, node: SyntaxNodeRef | SyntaxNode | null): Span | null {
  if (node === null) return null
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
      return revealSpan(state, node.node.parent)
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
  // What the selection is on, worked out BEFORE anything is decorated: an
  // element cannot know whether a smaller one inside it is the one being edited
  // until the whole span list exists, so the tree is walked twice. The first
  // walk collects ranges and nothing else.
  const visible = state.sliceDoc(from, to)
  // The wiki-link grammar is not part of the markdown tree, so its links are
  // parsed up here to join the span list. The same parse is reused at the foot
  // of this function rather than run twice.
  const wikiLinks = parseWikiLinks(visible)
  const spans: Span[] = wikiLinks.map((link) => ({ from: from + link.start, to: from + link.end }))
  const wikiSpans = [...spans]
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const span = revealSpan(state, node)
      if (span === null) return
      // A wiki-link owns its own range and the markdown parser does not know it
      // exists: it reads the inner `[notes/plan.md]` of `[[notes/plan.md]]` as a
      // shortcut Link, and a `|**Label**` as strong text. Those nodes are not
      // elements, and left in the list they would shadow the link they sit in —
      // the chip would never open. Same rule the frontmatter region gets below.
      if (wikiSpans.some((w) => span.from >= w.from && span.to <= w.to)) return
      spans.push(span)
    },
  })
  const revealed = revealedSpans(spans, state.selection.main)
  const isActive = (span: Span | null) => span !== null && revealed.has(spanKey(span))
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
      const activeHere = isActive(revealSpan(state, node))
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

  // Alphabetic ordered lists, which the parser does not report at all — the
  // predicate, and the reasoning behind how strict it is, live in `lists.ts`
  // beside the Enter that continues them.
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
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
