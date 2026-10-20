/**
 * The block gutter and block menu (after ReUI's `rich-text-block-gutter` and
 * `rich-text-block-menu`, docs/features/editor.md). Beside the block under the
 * pointer, on its first line: `+` opens a row below and types `/` there (⌥ for
 * above), and the grip drags the block or, clicked, opens its menu (⌘/ from
 * the keyboard). Every action rewrites the block's markdown lines
 * (`editor/blocks.ts`); the drop and the tints are CodeMirror's
 * (`editor/blockActions.ts`).
 */
import { startCompletion } from '@codemirror/autocomplete'
import { undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Plus,
  RefreshCw,
  SquareCode,
  TextQuote,
  Trash2,
  Type,
} from 'lucide-react'
import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { cn } from '@/lib/cn'
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Kbd,
  type IconGlyph,
} from '@/primitives'
import {
  activeBlockField,
  BLOCK_MIME,
  endBlockDrag,
  registerBlockMenuOpener,
  setActiveBlock,
} from '@/editor/blockActions'
import {
  blockAt,
  blockAtLine,
  canMoveBlock,
  deleteBlock,
  duplicateBlock,
  insertBlockRow,
  moveBlock,
  turnInto,
  turnIntoOptions,
  type Block,
  type BlockKind,
  type TurnIntoKind,
} from '@/editor/blocks'
import { outlineOf } from '@/editor/outline'

/** How the menu names each block, as the slash menu does. */
const TITLES: Partial<Record<BlockKind, string>> = {
  text: 'Text',
  'heading-1': 'Heading 1',
  'heading-2': 'Heading 2',
  'heading-3': 'Heading 3',
  'heading-4': 'Heading 4',
  'heading-5': 'Heading 5',
  'heading-6': 'Heading 6',
  'bullet-list': 'Bullet list',
  'numbered-list': 'Numbered list',
  'task-list': 'To-do list',
  quote: 'Quote',
  'code-block': 'Code block',
  divider: 'Divider',
  table: 'Table',
  contents: 'Contents',
}

const TURN_INTO: { kind: TurnIntoKind; title: string; icon: IconGlyph }[] = [
  { kind: 'text', title: 'Text', icon: Type },
  { kind: 'heading-1', title: 'Heading 1', icon: Heading1 },
  { kind: 'heading-2', title: 'Heading 2', icon: Heading2 },
  { kind: 'heading-3', title: 'Heading 3', icon: Heading3 },
  { kind: 'bullet-list', title: 'Bullet list', icon: List },
  { kind: 'numbered-list', title: 'Numbered list', icon: ListOrdered },
  { kind: 'task-list', title: 'To-do list', icon: ListTodo },
  { kind: 'quote', title: 'Quote', icon: TextQuote },
  { kind: 'code-block', title: 'Code block', icon: SquareCode },
]

/** How far below a block the pointer still counts as on it. */
const ROW_REACH = 48

interface Placed {
  block: Block
  /** In the container's box. */
  x: number
  y: number
}

/** Where a block's own text starts: past a list item's indentation, and inside
 *  an aligned block's wrapper. */
function textStart(view: EditorView, block: Block): number {
  const from = block.content.from
  return from + /^\s*/.exec(view.state.doc.lineAt(from).text)![0].length
}

/** The block on the row under `y`, probed just inside the text's edge. */
function blockAtY(view: EditorView, y: number): Block | null {
  const content = view.contentDOM.getBoundingClientRect()
  if (y < content.top || y > content.bottom) return null
  const pos = view.posAtCoords({ x: content.left + content.width / 2, y }, false)
  const line = view.state.doc.lineAt(pos)
  const block = blockAtLine(view.state, line.number)
  if (block === null) return null
  const bottom = view.lineBlockAt(block.to).bottom + view.documentTop
  return y - bottom > ROW_REACH ? null : block
}

function place(view: EditorView, block: Block, container: HTMLElement): Placed | null {
  const at = view.coordsAtPos(textStart(view, block), 1)
  if (at === null) return null
  const box = container.getBoundingClientRect()
  return {
    block,
    x: Math.round(at.left - box.left - 4),
    y: Math.round((at.top + at.bottom) / 2 - box.top),
  }
}

/** Keeps a press on the grip from opening the menu, so it can start a drag;
 *  the menu opens on click instead, which never follows a drag. */
function holdPress(event: SyntheticEvent): void {
  event.stopPropagation()
}

export function BlockGutter({
  view,
  container,
  onNotice,
}: {
  view: EditorView
  /** The positioned box the gutter is placed in. */
  container: HTMLElement
  /** Says what just happened, with a way back (a table deleted). */
  onNotice: (message: string, undo: () => void) => void
}): React.JSX.Element | null {
  const [placed, setPlaced] = useState<Placed | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirmTable, setConfirmTable] = useState<{ block: Block; name: string } | null>(null)
  const placedRef = useRef<Placed | null>(null)
  placedRef.current = placed
  const menuRef = useRef(false)
  menuRef.current = menuOpen
  const pointerY = useRef<number | null>(null)
  const openMenuRef = useRef<(block: Block) => void>(() => {})

  useEffect(() => {
    let lastX = -1
    let lastY = -1
    const follow = () => {
      if (menuRef.current) return
      const y = pointerY.current
      const block = y === null || view.state.readOnly ? null : blockAtY(view, y)
      setPlaced(block === null ? null : place(view, block, container))
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (e.clientX === lastX && e.clientY === lastY) return
      lastX = e.clientX
      lastY = e.clientY
      pointerY.current = e.clientY
      follow()
    }
    const onLeave = (e: PointerEvent) => {
      // Onto the gutter itself is still here.
      if (e.relatedTarget instanceof Node && container.contains(e.relatedTarget)) return
      pointerY.current = null
      follow()
    }
    // Typing hides the gutter until the pointer moves again.
    const onKey = (e: KeyboardEvent) => {
      if (['Alt', 'Control', 'Meta', 'Shift'].includes(e.key)) return
      pointerY.current = null
      follow()
    }
    const scroller = view.scrollDOM
    scroller.addEventListener('pointermove', onMove)
    scroller.addEventListener('pointerleave', onLeave)
    scroller.addEventListener('scroll', follow, { passive: true })
    view.contentDOM.addEventListener('keydown', onKey)
    const observer = new ResizeObserver(follow)
    observer.observe(view.contentDOM)
    // ⌘/: the menu for the caret's block, from the keyboard.
    const unregister = registerBlockMenuOpener(view, () => {
      const block = blockAt(view.state, view.state.selection.main.head)
      if (block === null) return false
      const at = place(view, block, container)
      if (at === null) return false
      setPlaced(at)
      openMenuRef.current(block)
      return true
    })
    return () => {
      scroller.removeEventListener('pointermove', onMove)
      scroller.removeEventListener('pointerleave', onLeave)
      scroller.removeEventListener('scroll', follow)
      view.contentDOM.removeEventListener('keydown', onKey)
      observer.disconnect()
      unregister()
    }
  }, [view, container])

  /** The menu reads the block now, with the caret moved into it and the block
   *  tinted, so every option is checked against this block. */
  const openMenu = (block: Block) => {
    const start = textStart(view, block)
    view.dispatch({
      selection: {
        anchor: Math.min(
          view.state.doc.lineAt(block.content.from).to,
          start + prefixLen(view, block),
        ),
      },
      effects: setActiveBlock.of({ from: block.from, to: block.to, kind: 'menu' }),
    })
    setMenuOpen(true)
  }
  openMenuRef.current = openMenu

  const closeMenu = () => {
    setMenuOpen(false)
    if (view.state.field(activeBlockField)?.kind === 'menu') {
      view.dispatch({ effects: setActiveBlock.of(null) })
    }
  }

  if (placed === null && !menuOpen && confirmTable === null) return null
  const block = placed?.block ?? null
  const current = block === null ? null : blockAt(view.state, block.from)

  const act = (spec: Parameters<EditorView['dispatch']>[0] | null) => {
    if (spec !== null) view.dispatch(spec)
    view.focus()
  }

  const addRow = (above: boolean) => {
    if (current === null) return
    view.dispatch(insertBlockRow(view.state, current, above ? 'before' : 'after'))
    // Typing "/" opens the slash menu there, as on any empty line.
    const at = view.state.selection.main.head
    view.dispatch({
      changes: { from: at, insert: '/' },
      selection: { anchor: at + 1 },
      userEvent: 'input.type',
    })
    view.focus()
    startCompletion(view)
    pointerY.current = null
    setPlaced(null)
  }

  const remove = () => {
    if (current === null) return
    if (current.kind === 'table') {
      setConfirmTable({ block: current, name: tableName(view, current) })
      return
    }
    act(deleteBlock(view.state, current))
  }

  const options = current === null ? [] : turnIntoOptions(current)

  return (
    <>
      {placed !== null && (
        <div
          className={cn(
            'absolute z-10 flex -translate-x-full -translate-y-1/2 items-center gap-0.5 motion-in-fade',
            dragging && 'pointer-events-none opacity-0',
          )}
          style={{ left: placed.x, top: placed.y }}
        >
          <IconButton
            icon={Plus}
            label="Add block below"
            tabIndex={-1}
            tooltip={
              <span className="flex flex-col items-start gap-0.5">
                <span>Add block below</span>
                <span className="flex items-center gap-1.5">
                  Add above <Kbd>⌥ Click</Kbd>
                </span>
              </span>
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => addRow(e.altKey)}
          />
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              if (!open) closeMenu()
            }}
          >
            <span className="flex" onPointerDownCapture={holdPress} onMouseDownCapture={holdPress}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  icon={GripVertical}
                  label="Block actions"
                  tabIndex={-1}
                  draggable
                  className="cursor-grab"
                  tooltip={
                    menuOpen || dragging ? (
                      false
                    ) : (
                      <span className="flex flex-col items-start gap-0.5">
                        <span>Drag to reorder</span>
                        <span className="flex items-center gap-1.5">
                          Block actions <Kbd>⌘/</Kbd>
                        </span>
                      </span>
                    )
                  }
                  onClick={() => (menuOpen ? closeMenu() : current !== null && openMenu(current))}
                  onDragStart={(e) => {
                    if (current === null || view.state.readOnly) return e.preventDefault()
                    e.dataTransfer.setData(BLOCK_MIME, String(current.from))
                    e.dataTransfer.effectAllowed = 'move'
                    const line = view.domAtPos(current.from).node
                    const el = line instanceof HTMLElement ? line : line.parentElement
                    const row = el?.closest('.cm-line') ?? el
                    if (row instanceof HTMLElement)
                      e.dataTransfer.setDragImage(row, 0, row.offsetHeight / 2)
                    // After the browser snapshots the drag image, so the ghost is not faded.
                    const from = current.from
                    const to = current.to
                    setTimeout(() => {
                      view.dispatch({ effects: setActiveBlock.of({ from, to, kind: 'drag' }) })
                      setDragging(true)
                    }, 0)
                  }}
                  onDragEnd={() => {
                    endBlockDrag(view)
                    setDragging(false)
                    pointerY.current = null
                    setPlaced(null)
                  }}
                />
              </DropdownMenuTrigger>
            </span>
            <DropdownMenuContent
              align="start"
              className="w-52"
              onCloseAutoFocus={(e) => {
                e.preventDefault()
                view.focus()
              }}
            >
              {current !== null && (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{TITLES[current.kind] ?? 'Block'}</DropdownMenuLabel>
                    {options.length > 0 && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Icon icon={RefreshCw} size="md" />
                          Turn into
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={current.kind}
                            onValueChange={(value) => {
                              // Picking the current kind again would do nothing.
                              if (value === current.kind) return
                              const now = blockAt(view.state, current.from)
                              if (now !== null)
                                act(turnInto(view.state, now, value as TurnIntoKind))
                            }}
                          >
                            {TURN_INTO.map((t) => (
                              <DropdownMenuRadioItem key={t.kind} value={t.kind}>
                                <Icon icon={t.icon} size="md" />
                                {t.title}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                    <DropdownMenuItem onClick={() => act(duplicateBlock(view.state, current))}>
                      <Icon icon={Copy} size="md" />
                      Duplicate
                      <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMoveBlock(view.state, current, -1)}
                      onClick={() => act(moveBlock(view.state, current, -1))}
                    >
                      <Icon icon={ArrowUp} size="md" />
                      Move up
                      <DropdownMenuShortcut>⌘⇧↑</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMoveBlock(view.state, current, 1)}
                      onClick={() => act(moveBlock(view.state, current, 1))}
                    >
                      <Icon icon={ArrowDown} size="md" />
                      Move down
                      <DropdownMenuShortcut>⌘⇧↓</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={remove}>
                    <Icon icon={Trash2} size="md" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <Dialog
        open={confirmTable !== null}
        onClose={() => setConfirmTable(null)}
        size="sm"
        closable={false}
      >
        <Dialog.Header>Delete table?</Dialog.Header>
        <Dialog.Body>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{confirmTable?.name}</span> and every row
            in it leave the page until you undo it.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onClick={() => setConfirmTable(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              const target = confirmTable
              setConfirmTable(null)
              if (target === null) return
              const now = blockAt(view.state, target.block.from)
              if (now === null || now.kind !== 'table') return
              act(deleteBlock(view.state, now))
              onNotice(`${target.name} deleted`, () => {
                undo(view)
                view.focus()
              })
            }}
          >
            Delete Table
          </Button>
        </Dialog.Footer>
      </Dialog>
    </>
  )
}

/** A block's markdown prefix, so the menu's caret lands on its text. */
function prefixLen(view: EditorView, block: Block): number {
  const text = view.state.doc.lineAt(block.content.from).text.trimStart()
  return /^(?:#{1,6}\s+|(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s+(?:\[[ xX]?\]\s+)?|>\s?)?/.exec(text)![0]
    .length
}

/** Tables have no title, so the heading above one names it. */
function tableName(view: EditorView, table: Block): string {
  const above = outlineOf(view.state).filter((h) => h.from < table.from)
  const heading = above[above.length - 1]
  return heading === undefined ? 'This table' : `${heading.text} table`
}
