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
  /** Closing: play the exit, and stop taking input while it runs. */
  leaving?: boolean
  /** This is the only pane and it is showing a note (`isSoloNote`), so the
   *  note's column centres (#13). Only the workspace can know it, which is why it is
   *  handed in rather than worked out from `pane`. */
  solo?: boolean
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
  /** Controls at the left-hand end of this pane's strip. */
  leading?: ReactNode
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
  leading,
}: PaneViewProps) {
  const tab = pane.active < 0 ? null : (pane.tabs[pane.active] ?? null)
  const syncState = useAtomValue(syncStateAtom)
  /** What a session spawned from anywhere should be born at: the last geometry
   *  a visible terminal actually measured. A session started for an ask has no
   *  tab of its own yet and so nothing of its own to measure. */
  const setGeometry = useSetAtom(agentGeometryAtom)

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

  // The pane's body fades when the tab it is showing changes identity. `tabKey`
  // rather than the index: moving a tab must not read as navigating to it.
  const bodyRef = useArrivalOnChange<HTMLDivElement>(tab == null ? 'empty' : tabKey(tab))

  return (
    // `onFocusCapture` as well as the pointer: tabbing into a pane, or a
    // CodeMirror instance taking focus, has to move the workspace's idea of
    // "here" too, or the next file opened from the tree lands somewhere else.
    <main
      className={cn(
        'flex h-full min-w-0 flex-col',
        // On its way out of a split. `pointer-events-none` because a pane you
        // have already closed must not accept a click during the 190ms it
        // spends leaving.
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
        leading={leading}
      />

      {/* The body is a drop surface too — dropping into the middle moves the tab
          here, and dropping on a quarter-width edge gives it a pane of its own.
          Wrapped rather than handled in place because the overlay needs
          somewhere to be absolutely positioned, and it must cover the content
          WITHOUT covering the strip, which has drop handling of its own. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Arrive on a swap. Opening a different note, or moving between a note
            and the board, used to be an instant replacement — the pane simply
            contained something else on the next frame. A short fade gives the
            navigation somewhere to land. Opacity only, because this wraps a
            CodeMirror instance and anything that changes the layout box drags
            its measure loop into every frame.

            The fade wraps only what a swap REPLACES. A session's terminal is
            rendered below, outside this wrapper, because it stays mounted while
            another tab is showing — and it is left out of the fade for the same
            reason: its pixels were already there, so fading them in on every
            switch read as the terminal blinking. Rendered as nothing rather
            than as an empty flex-1 box, which would take the height the
            terminals need. */}
        {tab?.kind === 'session' ? null : (
          <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
            {tab?.kind === 'app' ? (
              <AppFrame appId={tab.appId} />
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
              // Rich formats we can't yet render open a typed placeholder — a
              // real per-type viewer replaces it later (spec §Arbitrary files).
              // Text files (json/yaml/…) fall through to the plain editor below.
              <FilePlaceholder path={tab.path} kind="doc" />
            ) : (
              <EditorPane
                path={tab?.kind === 'note' ? tab.path : null}
                // A non-markdown text file (.json/.yaml/.env/…) edits in the
                // plain stack — no wiki-links, no frontmatter, syntax
                // highlighting by extension. Markdown notes keep the full editor.
                plain={tab?.kind === 'note' && fileKind(tab.path) === 'text'}
                centred={solo}
                // FR-19: a file the running reconcile is resolving opens locked.
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
         * Outside the switch above and keyed by session id, because a terminal
         * that unmounts on a tab switch throws away its scrollback and has to
         * replay main's mirror to get it back — a repaint you can see. The same
         * rule the drawer's tab strip followed; what changed is which container
         * enforces it.
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
              {/* Under the terminal it belongs to. Keyed, so the chip's own
                  "did this just land" refs are about ONE session and do not
                  bloom for a turn that ended minutes ago in another. */}
              <div className="shrink-0 border-t border-divider px-2 py-1">
                <TurnChip key={t.id} sessionId={t.id} />
              </div>
            </div>
          ),
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
