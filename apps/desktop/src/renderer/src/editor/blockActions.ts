/**
 * The CodeMirror half of the block gutter and block menu (after ReUI's
 * `rich-text-block-actions`, docs/features/editor.md): the active block's tint
 * (faded while it is dragged, tinted like a selection while its menu is open),
 * the drop line, the drop itself, and the block keys. The gutter and the menu
 * are React (`features/editor/BlockGutter.tsx`); everything they change goes
 * through `blocks.ts`, as markdown.
 */
import { selectNextOccurrence } from '@codemirror/search'
import {
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  layer,
  type Command,
  type DecorationSet,
  type LayerMarker,
} from '@codemirror/view'
import {
  blockAt,
  blockAtLine,
  duplicateBlock,
  moveBlock,
  moveBlockTo,
  turnInto,
  type Block,
  type TurnIntoKind,
} from './blocks'
import {
  alignOf,
  canAlign,
  highlightAt,
  setAlign,
  setHighlight,
  toggleUnderline,
  type Align,
} from './marks'

/** The drag's data type, so a block drop is never read as dropped text. */
export const BLOCK_MIME = 'application/x-holi-block'

export interface ActiveBlock {
  from: number
  to: number
  kind: 'drag' | 'menu'
}

/** Sets or clears the active block. */
export const setActiveBlock = StateEffect.define<ActiveBlock | null>()

export const activeBlockField = StateField.define<ActiveBlock | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveBlock)) return e.value
    if (value === null || !tr.docChanged) return value
    const from = tr.changes.mapPos(value.from, 1)
    const to = tr.changes.mapPos(value.to, -1)
    return to < from ? null : { ...value, from, to }
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state): DecorationSet => {
      const active = state.field(f)
      if (active === null) return Decoration.none
      const builder = new RangeSetBuilder<Decoration>()
      const deco = Decoration.line({
        class: active.kind === 'drag' ? 'cm-block-dragging' : 'cm-block-menu',
      })
      const last = state.doc.lineAt(Math.min(active.to, state.doc.length)).number
      for (let n = state.doc.lineAt(active.from).number; n <= last; n++) {
        const line = state.doc.line(n)
        builder.add(line.from, line.from, deco)
      }
      return builder.finish()
    }),
})

/** Where a dragged block would land: before or after a block. */
export interface DropTarget {
  block: Block
  side: 'before' | 'after'
}

const setDropTarget = StateEffect.define<DropTarget | null>()

const dropTargetField = StateField.define<DropTarget | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDropTarget)) return e.value
    return tr.docChanged ? null : value
  },
})

/** The drop line: 2px in the foreground, round-ended, on the seam between
 *  two blocks (ReUI's `DROP_LINE`). */
class DropLine implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
  ) {}
  draw(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-block-dropline'
    this.place(el)
    return el
  }
  update(dom: HTMLElement): boolean {
    this.place(dom)
    return true
  }
  eq(other: DropLine): boolean {
    return other.left === this.left && other.top === this.top && other.width === this.width
  }
  private place(el: HTMLElement): void {
    el.style.left = `${this.left}px`
    el.style.top = `${this.top}px`
    el.style.width = `${this.width}px`
  }
}

const dropLayer = layer({
  above: true,
  class: 'cm-block-droplayer',
  update: (u) =>
    u.docChanged ||
    u.geometryChanged ||
    u.transactions.some((tr) => tr.effects.some((e) => e.is(setDropTarget))),
  markers(view) {
    const target = view.state.field(dropTargetField)
    if (target === null) return []
    const { block, side } = target
    const line = view.lineBlockAt(side === 'before' ? block.from : block.to)
    const y = side === 'before' ? line.top : line.bottom
    const scroller = view.scrollDOM.getBoundingClientRect()
    const content = view.contentDOM.getBoundingClientRect()
    const baseLeft = scroller.left - view.scrollDOM.scrollLeft
    const baseTop = scroller.top - view.scrollDOM.scrollTop
    // Where the block's text starts: a list item's own indentation.
    const text = block.content.from
    const start = view.coordsAtPos(text + /^\s*/.exec(view.state.doc.lineAt(text).text)![0].length)
    const left = (start?.left ?? content.left) - baseLeft
    const width = content.right - (start?.left ?? content.left)
    return [new DropLine(left, view.documentTop + y - baseTop - 1, Math.max(24, width))]
  },
})

/** The block a drag over `y` would land beside, and on which side of it. A
 *  pointer over a blank line takes the block above it. */
export function dropTargetAt(view: EditorView, x: number, y: number): DropTarget | null {
  const content = view.contentDOM.getBoundingClientRect()
  const pos = view.posAtCoords({ x: Math.max(x, content.left + 4), y }, false)
  let n = view.state.doc.lineAt(pos).number
  let block = blockAtLine(view.state, n)
  while (block === null && n > 1) block = blockAtLine(view.state, --n)
  if (block === null) return null
  const top = view.lineBlockAt(block.from).top + view.documentTop
  const bottom = view.lineBlockAt(block.to).bottom + view.documentTop
  return { block, side: y < (top + bottom) / 2 ? 'before' : 'after' }
}

/** Reads the dragged block back from its drag data, by position. */
function sourceFrom(state: EditorState, data: string): Block | null {
  const from = Number(data)
  return Number.isFinite(from) ? blockAt(state, from) : null
}

/** Ends a block drag however it ended: dropped elsewhere, Escape, a drop
 *  outside the page. `dragend` fires on the grip, never on the editor. */
export function endBlockDrag(view: EditorView): void {
  if (view.state.field(dropTargetField, false) === undefined) return
  const effects = []
  if (view.state.field(dropTargetField) !== null) effects.push(setDropTarget.of(null))
  if (view.state.field(activeBlockField)?.kind === 'drag') effects.push(setActiveBlock.of(null))
  if (effects.length > 0) view.dispatch({ effects })
}

const dragHandlers = EditorView.domEventHandlers({
  dragover(event, view) {
    if (!event.dataTransfer?.types.includes(BLOCK_MIME)) return false
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const next = dropTargetAt(view, event.clientX, event.clientY)
    const now = view.state.field(dropTargetField)
    if (next?.block.from !== now?.block.from || next?.side !== now?.side) {
      view.dispatch({ effects: setDropTarget.of(next) })
    }
    return true
  },
  dragleave(event, view) {
    const into = event.relatedTarget
    if (into instanceof Node && view.dom.contains(into)) return false
    if (view.state.field(dropTargetField) !== null)
      view.dispatch({ effects: setDropTarget.of(null) })
    return false
  },
  drop(event, view) {
    if (!event.dataTransfer?.types.includes(BLOCK_MIME)) return false
    event.preventDefault()
    const target =
      view.state.field(dropTargetField) ?? dropTargetAt(view, event.clientX, event.clientY)
    const source = sourceFrom(view.state, event.dataTransfer.getData(BLOCK_MIME))
    const spec =
      source !== null && target !== null
        ? moveBlockTo(view.state, source, target.block, target.side)
        : null
    view.dispatch({
      ...(spec ?? {}),
      effects: [setDropTarget.of(null), setActiveBlock.of(null)],
    })
    view.focus()
    return true
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────────────

/** What ⌘/ opens: the gutter registers its menu here per view. */
const menuOpeners = new WeakMap<EditorView, () => boolean>()

export function registerBlockMenuOpener(view: EditorView, open: () => boolean): () => void {
  menuOpeners.set(view, open)
  return () => {
    if (menuOpeners.get(view) === open) menuOpeners.delete(view)
  }
}

const caretBlock = (state: EditorState): Block | null => blockAt(state, state.selection.main.head)

const onBlock =
  (
    act: (state: EditorState, block: Block) => Parameters<EditorView['dispatch']>[0] | null,
  ): Command =>
  (view) => {
    if (view.state.readOnly) return false
    const block = caretBlock(view.state)
    if (block === null) return false
    const spec = act(view.state, block)
    if (spec !== null) view.dispatch(spec)
    return true
  }

/** A kind's key turns the block into it, or back to text when it is one. */
const turn = (kind: TurnIntoKind): Command =>
  onBlock((state, block) =>
    turnInto(state, block, block.kind === kind && kind !== 'text' ? 'text' : kind),
  )

const align = (to: Align): Command =>
  onBlock((state, block) =>
    canAlign(block) ? setAlign(state, block, alignOf(state, block) === to ? 'left' : to) : null,
  )

const run =
  (spec: (state: EditorState) => Parameters<EditorView['dispatch']>[0] | null): Command =>
  (view) => {
    if (view.state.readOnly) return false
    const s = spec(view.state)
    if (s !== null) view.dispatch(s)
    return true
  }

/**
 * ReUI's block keys and Tiptap StarterKit's, over markdown. ⌘D duplicates the
 * block from a caret and, with a selection, keeps adding the next occurrence
 * (Holi's multi-cursor). ⌘/ takes over from toggle-comment, which stays on
 * ⇧⌥A. ⌘⇧↑/↓ move the block, as in Notion and ReUI, in place of extending the
 * selection to the document's ends.
 */
const blockKeymap = keymap.of([
  { key: 'Mod-Shift-ArrowUp', run: onBlock((s, b) => moveBlock(s, b, -1)), preventDefault: true },
  { key: 'Mod-Shift-ArrowDown', run: onBlock((s, b) => moveBlock(s, b, 1)), preventDefault: true },
  {
    key: 'Mod-d',
    run: (view) =>
      view.state.selection.main.empty
        ? onBlock((s, b) => duplicateBlock(s, b))(view)
        : selectNextOccurrence(view),
    preventDefault: true,
  },
  { key: 'Mod-/', run: (view) => !view.state.readOnly && (menuOpeners.get(view)?.() ?? false) },
  { key: 'Mod-Alt-0', run: turn('text') },
  { key: 'Mod-Alt-1', run: turn('heading-1') },
  { key: 'Mod-Alt-2', run: turn('heading-2') },
  { key: 'Mod-Alt-3', run: turn('heading-3') },
  { key: 'Mod-Shift-7', run: turn('numbered-list') },
  { key: 'Mod-Shift-8', run: turn('bullet-list') },
  { key: 'Mod-Shift-9', run: turn('task-list') },
  { key: 'Mod-Shift-b', run: turn('quote') },
  { key: 'Mod-Alt-c', run: turn('code-block') },
  { key: 'Mod-u', run: run(toggleUnderline) },
  {
    key: 'Mod-Shift-h',
    run: run((state) => setHighlight(state, highlightAt(state) === null ? 'yellow' : null)),
  },
  { key: 'Mod-Shift-l', run: align('left') },
  { key: 'Mod-Shift-e', run: align('center') },
  { key: 'Mod-Shift-r', run: align('right') },
  { key: 'Mod-Shift-j', run: align('justify') },
])

/** Everything the gutter needs from CodeMirror, and the block keys. */
export const blockActions: Extension = [
  activeBlockField,
  dropTargetField,
  dropLayer,
  Prec.high(dragHandlers),
  Prec.high(blockKeymap),
]
