/**
 * One pane: its tab strip, and whatever its active tab is showing.
 *
 * This was inline in `Shell` while there was exactly one of them. A split makes
 * it a thing that exists more than once, so it becomes a component — and the
 * component is deliberately dumb: it is handed its pane and its callbacks, and
 * every callback Shell builds already knows which pane index it belongs to. A
 * pane that reached for `workspaceAtom` itself would have to answer "which pane
 * am I" from global state, which is the question the props already answer.
 */
import { fileKind, isTaskFilePath } from '@holi/shared'
import { useEffect, useState, type ReactNode } from 'react'
import {
  TAB_MIME,
  paneDropZone,
  parseTabPayload,
  type PaneDropZone,
} from '@/lib/tab-drop'
import { EditorPane } from '@/composites'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { AppFrame } from '@/features/apps/AppFrame'
import { BoardView } from '@/features/tasks/BoardView'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { ImageViewer } from '@/features/files/ImageViewer'
import { TaskFileEditor } from '@/features/tasks/TaskFileEditor'
import type { Pane, Tab } from '@/state/panes'
import { TabStrip } from './TabStrip'

/** How a live drop target looks. The same treatment the file tree uses for its
 *  drop highlight, so a drag reads the same wherever it lands. */
const DROP_BAND = 'pointer-events-none absolute ring-1 ring-primary/60 ring-inset'

export interface PaneViewProps {
  pane: Pane
  /** Whether this is the pane that "open" means. Drives the strip's focus cue;
   *  with a single pane it is always true and the cue never shows. */
  focused: boolean
  /** Clicking anywhere in the pane focuses it — including in its content, so
   *  putting a caret in an editor moves the focus with it. */
  onFocus: () => void
  onSelect: (index: number) => void
  onPin: (index: number) => void
  onCloseTab: (index: number) => void
  /** Promote a preview tab because the user typed in it. */
  onEdit: () => void
  onOpenNote: (path: string) => void
  onConflict: (path: string) => void
  /** A tab was dropped on this pane — on its strip, or into the middle of its
   *  body. `index` is absolute within this pane's tabs. */
  onDropTab?: (tab: Tab, index: number) => void
  /** A tab was dropped on this pane's left or right quarter: it wants a pane of
   *  its own, on that side. */
  onDropEdge?: (tab: Tab, side: 'before' | 'after') => void
  /** Controls at the right-hand end of this pane's strip. */
  trailing?: ReactNode
}

export function PaneView({
  pane,
  focused,
  onFocus,
  onSelect,
  onPin,
  onCloseTab,
  onEdit,
  onOpenNote,
  onConflict,
  onDropTab,
  onDropEdge,
  trailing,
}: PaneViewProps) {
  const tab = pane.active < 0 ? null : (pane.tabs[pane.active] ?? null)

  /** A tab drag is currently over this pane's body. */
  const [dragging, setDragging] = useState(false)
  /** Which zone the pointer is in, or null where this pane offers nothing. */
  const [zone, setZone] = useState<PaneDropZone | null>(null)
  /** The drag started in *this* pane's strip. */
  const [fromHere, setFromHere] = useState(false)
  const takesDrops = onDropTab !== undefined || onDropEdge !== undefined

  /**
   * What this pane will actually accept, which is not always all three.
   *
   * **A pane never offers a drop that would do nothing.** Two cases, and both
   * are about the pane the drag came *from*:
   *
   *  - Its **middle** is noise. "Into this pane" means "move to the end of my
   *    own strip", which the strip itself already expresses — and on the way to
   *    an edge the pointer crosses the whole body, so a full-pane highlight
   *    flashes on every single split gesture. Left and right only.
   *  - With a **single tab** it offers nothing at all: the edges are the
   *    sole-tab-on-its-own-edge no-op (`moveTabToNewPane`) and the middle is a
   *    same-pane no-op (`moveTab`), so every zone is inert and lighting any of
   *    them up would promise something that cannot happen.
   *
   * Every *other* pane still offers all three — dropping into one is the
   * ordinary "put this over there" gesture.
   */
  const allowed: PaneDropZone[] = !fromHere
    ? ['before', 'into', 'after']
    : pane.tabs.length <= 1
      ? []
      : ['before', 'after']

  // A drag can end without this pane ever hearing about it — dropped on another
  // pane, or cancelled with escape while the pointer sits right here, in which
  // case `dragend` fires on the source pill in some *other* pane. Left alone,
  // the highlight would stay lit over a drag that finished a minute ago.
  useEffect(() => {
    if (!dragging && !fromHere) return
    const clear = () => {
      setDragging(false)
      setZone(null)
      setFromHere(false)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dragging, fromHere])

  const zoneAt = (e: React.DragEvent) =>
    paneDropZone(e.currentTarget.getBoundingClientRect(), e.clientX)

  return (
    // `onFocusCapture` as well as the pointer: tabbing into a pane, or a
    // CodeMirror instance taking focus, has to move the workspace's idea of
    // "here" too, or the next file opened from the tree lands somewhere else.
    <main
      className="flex h-full min-w-0 flex-col"
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <TabStrip
        tabs={pane.tabs}
        active={pane.active}
        focused={focused}
        onSelect={onSelect}
        onPin={onPin}
        onClose={onCloseTab}
        onDropTab={onDropTab}
        onDragBegin={() => setFromHere(true)}
        trailing={trailing}
      />

      {/* The body is a drop surface too — dropping into the middle moves the tab
          here, and dropping on a quarter-width edge gives it a pane of its own.
          Wrapped rather than handled in place because the overlay needs
          somewhere to be absolutely positioned, and it must cover the content
          WITHOUT covering the strip, which has drop handling of its own. */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!takesDrops || !e.dataTransfer.types.includes(TAB_MIME)) return
          setDragging(true)
        }}
      >
        {tab?.kind === 'app' ? (
          <AppFrame appId={tab.appId} />
        ) : tab?.kind === 'board' ? (
          <BoardView />
        ) : tab?.kind === 'agenda' ? (
          <AgendaView />
        ) : tab?.kind === 'mail' ? (
          <MailView />
        ) : tab?.kind === 'note' && fileKind(tab.path) === 'image' ? (
          <ImageViewer path={tab.path} />
        ) : tab?.kind === 'note' &&
          (fileKind(tab.path) === 'pdf' || fileKind(tab.path) === 'doc') ? (
          // Rich formats we can't yet render open a typed placeholder — a real
          // per-type viewer replaces it later (spec §Arbitrary files). Text
          // files (json/yaml/…) fall through to the plain editor below.
          <FilePlaceholder path={tab.path} kind={fileKind(tab.path) as 'pdf' | 'doc'} />
        ) : tab?.kind === 'note' && isTaskFilePath(tab.path) ? (
          // A task file renders as a task — a structured header over the body —
          // instead of raw frontmatter (prd/tasks.md; the file is still the truth).
          <TaskFileEditor
            path={tab.path}
            onOpenNote={onOpenNote}
            onEdit={onEdit}
            onConflict={onConflict}
          />
        ) : (
          <EditorPane
            path={tab?.kind === 'note' ? tab.path : null}
            // A non-markdown text file (.json/.yaml/.env/…) edits in the plain
            // stack — no wiki-links, no frontmatter, syntax highlighting by
            // extension. Markdown notes keep the full editor.
            plain={tab?.kind === 'note' && fileKind(tab.path) === 'text'}
            onOpenNote={onOpenNote}
            onEdit={onEdit}
            onConflict={onConflict}
          />
        )}

        {/* One event target, always. The bands inside are `pointer-events-none`,
            so crossing them fires no `dragleave` — which is the papercut that
            makes hand-rolled HTML5 drop zones flicker. */}
        {dragging && allowed.length > 0 && (
          <div
            className="absolute inset-0 z-10"
            data-testid="pane-drop-overlay"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_MIME)) return
              const side = zoneAt(e)
              // A zone this pane does not offer stays inert: no highlight, and
              // no `preventDefault`, so the cursor says "not here" rather than
              // promising a drop that would be a no-op.
              if (!allowed.includes(side)) return setZone(null)
              // Without this the drop never fires.
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setZone(side)
            }}
            onDragLeave={() => {
              setDragging(false)
              setZone(null)
            }}
            onDrop={(e) => {
              const side = zoneAt(e)
              const dropped = parseTabPayload(e.dataTransfer.getData(TAB_MIME))
              setDragging(false)
              setZone(null)
              if (dropped === null || !allowed.includes(side)) return
              e.preventDefault()
              if (side === 'into') onDropTab?.(dropped, pane.tabs.length)
              else onDropEdge?.(dropped, side)
            }}
          >
            {zone === null ? null : zone === 'into' ? (
              <div className={`${DROP_BAND} inset-0 bg-primary/10`} />
            ) : (
              // `min(25%, 120px)` is `paneDropZone`'s rule drawn rather than
              // computed. The two have to agree, so they say the same thing.
              <div
                className={`${DROP_BAND} inset-y-0 bg-primary/20 ${
                  zone === 'before' ? 'left-0' : 'right-0'
                }`}
                style={{ width: 'min(25%, 120px)' }}
              />
            )}
          </div>
        )}
      </div>
    </main>
  )
}
