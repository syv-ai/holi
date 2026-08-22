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
import { useAtomValue } from 'jotai'
import { isLockedForReconcile } from '@/lib/reconcile-lock'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { syncStateAtom } from '@/state/vaults'
import { useEffect, useState, type ReactNode } from 'react'
import { TAB_MIME, paneDropZone, parseTabPayload, type PaneDropZone } from '@/lib/tab-drop'
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

/** What every drop target shares: a plain wash, positioned out of flow.
 *
 *  `pointer-events-none` is the load-bearing half — it is what keeps the
 *  overlay a single event target, so crossing a band fires no `dragleave` and
 *  the highlight cannot flicker. The fill is left to the caller. */
const DROP_BAND = 'pointer-events-none absolute'

/**
 * A landing strip for a split, down one side of the pane.
 *
 * **Drawn from the moment a tab is picked up**, not when the pointer arrives.
 * A target that only exists once you have guessed where it is teaches nobody
 * the gesture — the edges have to be visible *before* you aim at them, or
 * splitting by drag is a feature you either already know about or never find.
 * Dim while it waits, lit when the pointer is actually inside it.
 */
function EdgeBand({ side, active }: { side: 'before' | 'after'; active: boolean }) {
  return (
    <div
      data-testid={`pane-drop-${side}`}
      className={`${DROP_BAND} inset-y-0 ${side === 'before' ? 'left-0' : 'right-0'} ${
        // No outline: the fill alone says where it is. The resting state is
        // heavier than it would be with one, because the border was carrying
        // most of a waiting strip's visibility and it still has to be findable.
        active ? 'bg-primary/25' : 'bg-primary/10'
      }`}
      style={{ width: 'min(25%, 120px)' }}
    />
  )
}

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
  onConflict: (path: string, resolve: ConflictResolvers) => void
  /** A tab was dropped on this pane — on its strip, or into the middle of its
   *  body. `index` is absolute within this pane's tabs. */
  onDropTab?: (tab: Tab, index: number) => void
  /** A tab was dropped on this pane's left or right quarter: it wants a pane of
   *  its own, on that side. */
  onDropEdge?: (tab: Tab, side: 'before' | 'after') => void
  /** Which of this pane's zones the drag in flight could actually use, from
   *  `dropZones` — empty when nothing is being dragged, which is also what
   *  keeps the overlay off screen. A pane does not work this out for itself:
   *  whether an edge would do anything depends on where the dragged tab lives
   *  and on the pane *next door*, and only the workspace knows both. */
  allowed?: PaneDropZone[]
  /** A drag started in this pane's strip, carrying that tab. */
  onDragBegin?: (tab: Tab) => void
  /** Whether a tab drag is currently over this pane's strip. The workspace uses
   *  it to keep the landing strips out of sight while a reorder is being aimed
   *  — see `overStrip` in Shell. */
  onDragOverStrip?: (over: boolean) => void
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
  allowed = [],
  onDragBegin,
  onDragOverStrip,
  trailing,
}: PaneViewProps) {
  const tab = pane.active < 0 ? null : (pane.tabs[pane.active] ?? null)
  const syncState = useAtomValue(syncStateAtom)

  /** Which zone the pointer is in, or null where this pane offers nothing. */
  const [zone, setZone] = useState<PaneDropZone | null>(null)

  // A drag that ended elsewhere leaves no highlight behind: `allowed` empties
  // the moment the workspace stops reporting a drag, and the overlay goes with
  // it — but the hovered zone is local, so it is cleared here.
  useEffect(() => {
    if (allowed.length === 0) setZone(null)
  }, [allowed.length])

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
        onDragBegin={onDragBegin}
        onDragOverStrip={onDragOverStrip}
        trailing={trailing}
      />

      {/* The body is a drop surface too — dropping into the middle moves the tab
          here, and dropping on a quarter-width edge gives it a pane of its own.
          Wrapped rather than handled in place because the overlay needs
          somewhere to be absolutely positioned, and it must cover the content
          WITHOUT covering the strip, which has drop handling of its own. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
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
            // FR-19: a file the running reconcile is resolving opens locked.
            readOnly={tab?.kind === 'note' && isLockedForReconcile(syncState, tab.path)}
            onOpenNote={onOpenNote}
            onEdit={onEdit}
            onConflict={onConflict}
          />
        )}

        {/* One event target, always. The bands inside are `pointer-events-none`,
            so crossing them fires no `dragleave` — which is the papercut that
            makes hand-rolled HTML5 drop zones flicker. */}
        {allowed.length > 0 && (
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
            onDragLeave={() => setZone(null)}
            onDrop={(e) => {
              const side = zoneAt(e)
              const dropped = parseTabPayload(e.dataTransfer.getData(TAB_MIME))
              setZone(null)
              if (dropped === null || !allowed.includes(side)) return
              e.preventDefault()
              if (side === 'into') onDropTab?.(dropped, pane.tabs.length)
              else onDropEdge?.(dropped, side)
            }}
          >
            {/* `min(25%, 120px)` inside `EdgeBand` is `paneDropZone`'s rule drawn
                rather than computed. The two have to agree, so they say the
                same thing. The middle has no waiting state — it is the whole
                pane, and a full-pane wash that appeared on every drag is what
                this overlay was narrowed to stop. */}
            {allowed.includes('before') && <EdgeBand side="before" active={zone === 'before'} />}
            {allowed.includes('after') && <EdgeBand side="after" active={zone === 'after'} />}
            {zone === 'into' && (
              <div data-testid="pane-drop-into" className={`${DROP_BAND} inset-0 bg-primary/10`} />
            )}
          </div>
        )}
      </div>
    </main>
  )
}
