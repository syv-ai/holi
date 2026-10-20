/**
 * The note's page controls (after ReUI's page header and `page-actions`,
 * docs/features/editor.md): whether it is saved, Undo and Redo, the outline
 * where the rail has no room, and the page menu with Full width, Small text,
 * Lock page, Export and Clear page.
 *
 * It sits in the editor's top corner rather than in the pane header, which
 * belongs to the pane: the header names the tab, this acts on the page.
 */
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import {
  ArrowLeftRight,
  Check,
  Code,
  Copy,
  FileText,
  Lock,
  MoreHorizontal,
  Redo2,
  TableOfContents,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/primitives'
import { noteBody, noteToHtml, noteToText } from '@/editor/export'
import { frontmatterRegion } from '@/editor/frontmatter-region'
import { currentHeading, outlineOf, type OutlineHeading } from '@/editor/outline'
import { onEditorUpdate } from '@/editor/update-bus'
import type { NotePage } from '@/state/note-page'

type CopyFormat = 'html' | 'text' | 'markdown'

/** Long enough to read the swap, short enough to copy again. */
const COPIED_MS = 1600

export function PageActions({
  view,
  title,
  page,
  onPageChange,
  saving,
  showOutline,
  onNotice,
}: {
  view: EditorView
  /** The note's name, for the Clear page confirm. */
  title: string
  page: NotePage
  onPageChange: (patch: Partial<NotePage>) => void
  saving: boolean
  /** The rail has no room: the outline is a button here instead. */
  showOutline: boolean
  onNotice: (message: string, undo?: () => void) => void
}): React.JSX.Element {
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [copied, setCopied] = useState<CopyFormat | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const read = () => {
      const next = { undo: undoDepth(view.state), redo: redoDepth(view.state) }
      setHistory((now) => (now.undo === next.undo && now.redo === next.redo ? now : next))
    }
    read()
    return onEditorUpdate(view, (u) => u.transactions.length > 0 && read())
  }, [view])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const editable = !page.locked && !view.state.readOnly
  const run = (command: (target: EditorView) => boolean) => {
    command(view)
    view.focus()
  }

  // A copy confirms in place on the item; only a failure says so out loud.
  const copyAs = async (format: CopyFormat) => {
    const text = view.state.doc.toString()
    const value =
      format === 'html' ? noteToHtml(text) : format === 'text' ? noteToText(text) : noteBody(text)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(format)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS)
    } catch {
      onNotice('Copy failed: the clipboard is not available.')
    }
  }

  const clearPage = () => {
    setConfirmClear(false)
    const from = frontmatterRegion(view.state.doc.toString())?.to ?? 0
    view.dispatch({
      changes: { from, to: view.state.doc.length },
      selection: { anchor: from },
      userEvent: 'delete.clear',
    })
    view.focus()
    onNotice('Page cleared', () => run(undo))
  }

  const copyItem = (format: CopyFormat, label: string, icon: typeof Code) => (
    <DropdownMenuItem
      // Stays open, so the swap to Copied is seen where it was clicked.
      onSelect={(e) => e.preventDefault()}
      onClick={() => void copyAs(format)}
    >
      <Icon icon={copied === format ? Check : icon} size="md" />
      {copied === format ? 'Copied' : label}
    </DropdownMenuItem>
  )

  return (
    <div className="flex items-center gap-1">
      <span aria-live="polite" className="px-1 text-xs text-muted-foreground">
        {saving ? 'Saving…' : 'Saved'}
      </span>
      {page.locked && (
        <Badge variant="outline" className="font-normal">
          Locked
        </Badge>
      )}
      <IconButton
        icon={Undo2}
        label="Undo"
        tooltip="Undo  ⌘Z"
        disabled={!editable || history.undo === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(undo)}
      />
      <IconButton
        icon={Redo2}
        label="Redo"
        tooltip="Redo  ⌘⇧Z"
        disabled={!editable || history.redo === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(redo)}
      />
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      {showOutline && <OutlinePopover view={view} />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton icon={MoreHorizontal} label="Page actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            view.focus()
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Page</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={page.fullWidth}
              onCheckedChange={(on) => onPageChange({ fullWidth: on === true })}
              onSelect={(e) => e.preventDefault()}
            >
              <Icon icon={ArrowLeftRight} size="md" />
              Full width
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={page.smallText}
              onCheckedChange={(on) => onPageChange({ smallText: on === true })}
              onSelect={(e) => e.preventDefault()}
            >
              <Icon icon={Type} size="md" />
              Small text
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={page.locked}
              onCheckedChange={(on) => onPageChange({ locked: on === true })}
              onSelect={(e) => e.preventDefault()}
            >
              <Icon icon={Lock} size="md" />
              Lock page
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Export</DropdownMenuLabel>
            {copyItem('html', 'Copy as HTML', Code)}
            {copyItem('text', 'Copy as text', Copy)}
            {copyItem('markdown', 'Copy as markdown', FileText)}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!editable}
            onClick={() => setConfirmClear(true)}
          >
            <Icon icon={Trash2} size="md" />
            Clear page
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} size="sm" closable={false}>
        <Dialog.Header>Clear page?</Dialog.Header>
        <Dialog.Body>
          <p className="text-sm text-muted-foreground">
            Every block of <span className="font-medium text-foreground">{title}</span> is removed
            until you undo it. Its properties stay.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={clearPage}>
            Clear page
          </Button>
        </Dialog.Footer>
      </Dialog>
    </div>
  )
}

/** The outline rail's list where the rail has no room (ReUI's outline popover). */
function OutlinePopover({ view }: { view: EditorView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [headings, setHeadings] = useState<OutlineHeading[]>([])
  const current = currentHeading(headings, view.state.selection.main.head)
  const top = Math.min(...headings.map((h) => h.level))
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setHeadings(outlineOf(view.state))
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <IconButton icon={TableOfContents} label="Outline" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-1"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          view.focus()
        }}
      >
        <p className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Outline</p>
        {headings.length === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">No headings yet.</p>
        ) : (
          <nav aria-label="Outline" className="flex max-h-72 flex-col overflow-y-auto">
            {headings.map((h, i) => (
              <Button
                key={`${h.from}:${h.text}`}
                variant="ghost"
                size="sm"
                aria-current={i === current ? 'location' : undefined}
                className={cn(
                  'h-7 w-full min-w-0 justify-start px-2 text-nav font-normal text-muted-foreground',
                  'aria-[current=location]:font-medium aria-[current=location]:text-foreground',
                )}
                style={{ paddingInlineStart: `${0.5 + Math.min(h.level - top, 2) * 0.75}rem` }}
                onClick={() => {
                  setOpen(false)
                  view.dispatch({
                    selection: { anchor: h.from },
                    effects: EditorView.scrollIntoView(h.from, { y: 'start', yMargin: 24 }),
                  })
                }}
              >
                <span className="truncate">{h.text}</span>
              </Button>
            ))}
          </nav>
        )}
      </PopoverContent>
    </Popover>
  )
}
