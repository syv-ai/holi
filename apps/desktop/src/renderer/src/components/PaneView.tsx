/**
 * One pane: its tab strip, and whatever its active tab is showing.
 *
 * Deliberately dumb: Shell hands it its pane and callbacks already bound to
 * the pane index, so it never asks `workspaceAtom` "which pane am I".
 */
import { fileKind, isTaskFilePath } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/cn'
import { isLockedForReconcile } from '@/lib/reconcile-lock'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { agentGeometryAtom } from '@/state/agent'
import { syncStateAtom } from '@/state/vaults'
import { useEffect, useState, type ReactNode } from 'react'
import { TAB_MIME, paneDropZone, parseTabPayload, type PaneDropZone } from '@/lib/tab-drop'
import { EditorPane } from '@/composites'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { AppFrame } from '@/features/apps/AppFrame'
import { SettingsView } from '@/features/settings/SettingsView'
import { HistoryView } from '@/features/history/HistoryView'
import { BoardView } from '@/features/tasks/BoardView'
import { SessionTerminal } from '@/features/agent/SessionTerminal'
import { TurnChip } from '@/features/agent/TurnChip'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { ImageViewer } from '@/features/files/ImageViewer'
import { PdfViewer } from '@/features/files/PdfViewer'
import type { Pane, Tab } from '@/state/panes'
import { useArrivalOnChange } from '@/lib/use-arrivals'
import { TabStrip, tabKey } from './TabStrip'

/** What every drop target shares. `pointer-events-none` keeps the overlay a
 *  single event target, so crossing a band fires no `dragleave` flicker. */
const DROP_BAND = 'pointer-events-none absolute'

/**
 * A landing strip for a split, down one side of the pane.
 *
 * Visible before the pointer aims at it (once the drag leaves the tab strip),
 * or nobody would discover splitting by drag. Dim while waiting, lit when the
 * pointer is inside.
 */
function EdgeBand({ side, active }: { side: 'before' | 'after'; active: boolean }) {
  return (
    <div
      data-testid={`pane-drop-${side}`}
      className={`${DROP_BAND} inset-y-0 ${side === 'before' ? 'left-0' : 'right-0'} ${
        // No outline, so the resting fill is heavy enough to be findable.
        active ? 'bg-primary/25' : 'bg-primary/10'
      }`}
      style={{ width: 'min(25%, 120px)' }}
    />
  )
}

export interface PaneViewProps {
  pane: Pane
  /** Whether this is the pane that "open" means. */
  focused: boolean
  /** Closing: play the exit, and stop taking input while it runs. */
  leaving?: boolean
  /** The only pane, showing a note (`isSoloNote`), so the column centres. Only
   *  the workspace can know it. */
  solo?: boolean
  /** Clicking or focusing anywhere in the pane, content included, focuses it. */
  onFocus: () => void
  onSelect: (index: number) => void
  onPin: (index: number) => void
  onCloseTab: (index: number) => void
  /** Promote a preview tab because the user typed in it. */
  onEdit: () => void
  onOpenNote: (path: string) => void
  onConflict: (path: string, resolve: ConflictResolvers) => void
  /** A tab was dropped on this pane's strip or body. `index` is absolute within
   *  this pane's tabs. */
  onDropTab?: (tab: Tab, index: number) => void
  /** A tab was dropped on this pane's left or right quarter: a new pane there. */
  onDropEdge?: (tab: Tab, side: 'before' | 'after') => void
  /** The zones the drag in flight could use, from `dropZones`; empty hides the
   *  overlay. Only the workspace knows the neighbouring pane, so it decides. */
  allowed?: PaneDropZone[]
  /** A drag started in this pane's strip, carrying that tab. */
  onDragBegin?: (tab: Tab) => void
  /** Whether a tab drag is over this pane's strip (see `overStrip` in Shell). */
  onDragOverStrip?: (over: boolean) => void
  /** Controls at the right-hand end of this pane's strip. */
  trailing?: ReactNode
}

export function PaneView({
  pane,
  focused,
  leaving = false,
  solo = false,
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
  /** The last geometry a visible terminal measured, for sessions spawned
   *  without a tab of their own to measure. */
  const setGeometry = useSetAtom(agentGeometryAtom)

  /** Which zone the pointer is in, or null where this pane offers nothing. */
  const [zone, setZone] = useState<PaneDropZone | null>(null)

  // The hovered zone is local, so clear it when `allowed` empties.
  useEffect(() => {
    if (allowed.length === 0) setZone(null)
  }, [allowed.length])

  const zoneAt = (e: React.DragEvent) =>
    paneDropZone(e.currentTarget.getBoundingClientRect(), e.clientX)

  // The pane's body fades when the tab it is showing changes identity. `tabKey`
  // rather than the index: moving a tab must not read as navigating to it.
  const bodyRef = useArrivalOnChange<HTMLDivElement>(tab == null ? 'empty' : tabKey(tab))

  return (
    // `onFocusCapture` too: keyboard or CodeMirror focus must also move the
    // workspace's idea of "here".
    <main
      className={cn(
        'flex h-full min-w-0 flex-col',
        // A closed pane must not take clicks while it leaves.
        leaving && 'motion-out-origin pointer-events-none',
      )}
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

      {/* The body is a drop surface too. Wrapped so the overlay covers the
          content but not the strip, which handles its own drops. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Fade on a swap. Opacity only: this wraps CodeMirror, and a layout
            change would drag its measure loop into every frame.

            Sessions render below, outside the fade: they stay mounted, and
            fading them read as blinking. Nothing rather than an empty flex-1
            box, which would take the terminals' height. */}
        {tab?.kind === 'session' ? null : (
          <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
            {tab?.kind === 'app' ? (
              <AppFrame path={tab.path} />
            ) : tab?.kind === 'board' ? (
              <BoardView />
            ) : tab?.kind === 'agenda' ? (
              <AgendaView />
            ) : tab?.kind === 'mail' ? (
              <MailView />
            ) : tab?.kind === 'settings' ? (
              <SettingsView />
            ) : tab?.kind === 'history' ? (
              <HistoryView />
            ) : tab?.kind === 'note' && fileKind(tab.path) === 'image' ? (
              <ImageViewer path={tab.path} />
            ) : tab?.kind === 'note' && fileKind(tab.path) === 'pdf' ? (
              <PdfViewer path={tab.path} />
            ) : tab?.kind === 'note' && fileKind(tab.path) === 'doc' ? (
              // Rich formats we cannot render open a typed placeholder. Text
              // files fall through to the plain editor below.
              <FilePlaceholder path={tab.path} kind="doc" />
            ) : (
              <EditorPane
                path={tab?.kind === 'note' ? tab.path : null}
                // Non-markdown text edits in the plain stack: no wiki-links or
                // frontmatter, syntax highlighting by extension.
                plain={tab?.kind === 'note' && fileKind(tab.path) === 'text'}
                centred={solo}
                // A file the running reconcile is resolving opens locked.
                readOnly={tab?.kind === 'note' && isLockedForReconcile(syncState, tab.path)}
                onOpenNote={onOpenNote}
                onEdit={onEdit}
                onConflict={onConflict}
              />
            )}
          </div>
        )}

        {/**
         * Every session tab in this pane, mounted, with only the active one
         * shown (D101).
         *
         * Outside the switch and keyed by session id: an unmounted terminal
         * loses its scrollback and must visibly replay main's mirror.
         */}
        {pane.tabs.map((t, i) =>
          t.kind !== 'session' ? null : (
            <div
              key={`session:${t.id}`}
              className={cn('min-h-0 flex-1 flex-col', i === pane.active ? 'flex' : 'hidden')}
            >
              <SessionTerminal
                sessionId={t.id}
                visible={i === pane.active}
                onGeometry={(cols, rows) => setGeometry({ cols, rows })}
              />
              {/* Keyed, so the chip's "just landed" refs belong to one
                  session. */}
              <div className="shrink-0 border-t border-divider px-2 py-1">
                <TurnChip key={t.id} sessionId={t.id} />
              </div>
            </div>
          ),
        )}

        {/* One event target: the bands inside are `pointer-events-none`, so
            crossing them fires no flickering `dragleave`. */}
        {allowed.length > 0 && (
          <div
            className="absolute inset-0 z-10"
            data-testid="pane-drop-overlay"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_MIME)) return
              const side = zoneAt(e)
              // An unoffered zone stays inert, so the cursor says "not here".
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
            {/* `EdgeBand`'s `min(25%, 120px)` must agree with `paneDropZone`.
                The middle has no waiting state: a full-pane wash on every drag
                is noise. */}
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
