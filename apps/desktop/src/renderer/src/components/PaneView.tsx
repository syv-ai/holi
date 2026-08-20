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
import type { ReactNode } from 'react'
import { EditorPane } from '@/composites'
import { AgendaView } from '@/features/google/AgendaView'
import { MailView } from '@/features/google/MailView'
import { AppFrame } from '@/features/apps/AppFrame'
import { BoardView } from '@/features/tasks/BoardView'
import { FilePlaceholder } from '@/features/files/FilePlaceholder'
import { ImageViewer } from '@/features/files/ImageViewer'
import { TaskFileEditor } from '@/features/tasks/TaskFileEditor'
import type { Pane } from '@/state/panes'
import { TabStrip } from './TabStrip'

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
  trailing,
}: PaneViewProps) {
  const tab = pane.active < 0 ? null : (pane.tabs[pane.active] ?? null)

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
        trailing={trailing}
      />

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
      ) : tab?.kind === 'note' && (fileKind(tab.path) === 'pdf' || fileKind(tab.path) === 'doc') ? (
        // Rich formats we can't yet render open a typed placeholder — a real
        // per-type viewer replaces it later (spec §Arbitrary files). Text
        // files (json/yaml/…) fall through to the plain editor below.
        <FilePlaceholder path={tab.path} kind={fileKind(tab.path) as 'pdf' | 'doc'} />
      ) : tab?.kind === 'note' && isTaskFilePath(tab.path) ? (
        // A task file renders as a task — a structured header over the body —
        // instead of raw frontmatter (prd/tasks.md; the file is still the truth).
        <TaskFileEditor path={tab.path} onOpenNote={onOpenNote} onEdit={onEdit} onConflict={onConflict} />
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
    </main>
  )
}
