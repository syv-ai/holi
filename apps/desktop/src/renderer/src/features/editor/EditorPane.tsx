/**
 * One note, one buffer, one file: an autosave that writes the buffer, and
 * `decideReload` for when the file changes underneath. Concurrent editing is
 * deferred (`vision.md`).
 *
 * `base` is the text this editor last loaded or saved. Advancing it on save
 * makes the editor's own write a non-event: by the time the watcher reports
 * it, `disk === base`. The decision lives in `lib/editor-reload.ts`.
 *
 * `@` completes notes and open tasks; either inserts an ordinary path
 * wiki-link.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { snapshotTasks, type Task } from '@holi/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useEffect, useRef } from 'react'
import { baseEditorExtensions, plainTextExtensions } from '@/editor/extensions'
import { bodyStart, frontmatterValid, setFrontmatterCommit } from '@/editor/frontmatter'
import { syntaxValid } from '@/editor/languages'
import type { LinkNav } from '@/editor/links'
import type { MentionData } from '@/editor/mentions'
import { playOnce } from '@/lib/motion'
import { applyReload } from '@/lib/apply-reload'
import { registerBuffer } from '@/lib/buffer-registry'
import { decideReload, hasNewText, type ConflictResolvers } from '@/lib/editor-reload'
import { NO_AGENT, useAskAgentSeam } from '@/state/agent-service'
import { historyOpenAtom } from '@/state/history'
import { normalizersAtom } from '@/state/plugins'
import { trpc } from '@/lib/trpc'
import { fileHistoryAtom } from '@/state/file-history'
import { memberLoginsAtom } from '@/state/members'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/** Quiet before the buffer reaches disk. Shorter than main's commit debounce on
 *  purpose: the file has to be there before the commit timer decides to look. */
const SAVE_QUIET_MS = 600

type JotaiStore = ReturnType<typeof useStore>

/**
 * The frontmatter summary's last commit, into `view`, now and whenever the
 * file's history moves: a note opened before its first autosave commit gains
 * its "Last updated" when that lands. Returns the unsubscribe.
 */
function followCommit(view: EditorView, path: string, store: JotaiStore): () => void {
  const history = fileHistoryAtom(path)
  const push = () => {
    const answer = store.get(history)
    // Undefined is "not answered yet": the summary waits rather than drawing
    // a half line that grows.
    if (answer === undefined) return
    view.dispatch({
      effects: setFrontmatterCommit.of(
        answer === null ? null : { ...answer.last, revisions: answer.revisions },
      ),
    })
  }
  const off = store.sub(history, push)
  push()
  return off
}

export function EditorPane({
  path,
  onOpenNote,
  onConflict,
  onEdit,
  plain = false,
  readOnly = false,
}: {
  path: string | null
  onOpenNote: (path: string) => void
  onConflict: (path: string, resolve: ConflictResolvers) => void
  /** Fired the first time the buffer changes for this open note: editing
   *  promotes a preview tab to pinned (docs/features/tabs-panes.md). */
  onEdit?: () => void
  /** A non-markdown text file: swap in the plain editing stack, open the caret at
   *  the top, and never hold off the save on frontmatter (it has none). The
   *  save/flush/reload machinery is otherwise identical. */
  plain?: boolean
  /** A reconcile is resolving this file (docs/features/vaults-sync.md). The
   *  document opens locked: a keystroke between the agent's read and its write
   *  would build a resolution on a file that moved. */
  readOnly?: boolean
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  /** Read by the reload and save paths when they run, so the editor follows
   *  the claims the vault runs now without rebuilding. */
  const normalizerList = useAtomValue(normalizersAtom)
  const normalizers = useRef(normalizerList)
  normalizers.current = normalizerList
  const store = useStore()
  const hostRef = useRef<HTMLDivElement>(null)

  /** The text last loaded or saved; advanced by the save before the watcher
   *  reports it. */
  const baseRef = useRef('')
  const viewRef = useRef<EditorView | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether `onEdit` has fired for this open note; reset per open. */
  const editedRef = useRef(false)

  // Read on demand by the editor's pull-based seams, so a snapshot arriving
  // mid-edit does not rebuild the EditorView and drop the caret.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshotTasks(snapshot).items.map((t) => [t.path, t]))
  const people = useAtomValue(memberLoginsAtom)
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({
      path: d.path,
      ...(snapshot.icons[d.path] === undefined ? {} : { icon: snapshot.icons[d.path] }),
    })),
    tasks: snapshotTasks(snapshot).items.map((t) => ({
      path: t.path,
      title: t.title,
      status: t.status,
      ...(t.due === undefined ? {} : { due: t.due }),
    })),
    people,
  }
  const setHistoryOpen = useSetAtom(historyOpenAtom)
  /** In a ref, like `nav`: the extensions must not rebuild on every render.
   *  Whether there is an agent at all does rebuild them, below. */
  const askAgent = useAskAgentSeam()
  const askAgentRef = useRef(askAgent)
  askAgentRef.current = askAgent
  const hasAgent = askAgent !== null
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    // A link to a missing note or task no-ops rather than inventing a file.
    openNote: (target) =>
      (docPaths.current.has(target) || tasksByPath.current.has(target)) && onOpenNote(target),
    openExternal: (url) => void window.holi.openExternal(url),
    // Open, never toggle. Focus first: the sidebar follows the active pane, a
    // pane activates on focus, and the link's mousedown is prevented, so in a
    // split the press alone would open the other pane's history.
    openHistory: () => {
      viewRef.current?.focus()
      setHistoryOpen(true)
    },
  }

  useEffect(() => {
    if (path === null || remote === null || hostRef.current === null) return
    let disposed = false
    let unfollow = () => {}
    editedRef.current = false
    const host = hostRef.current

    /** Write the buffer if it differs from disk, advancing `base` first.
     *  Unconditional: used by the flush registry (quit, rename's pre-flush) and
     *  the unmount below, where losing keystrokes is worse than temporarily
     *  invalid frontmatter. */
    const flush = async (): Promise<void> => {
      const view = viewRef.current
      if (view === null || disposed) return
      const text = view.state.doc.toString()
      if (!hasNewText(baseRef.current, text, path, normalizers.current)) return
      baseRef.current = text
      await trpc.notes.write.mutate({ remote, path, text })
    }

    /** The gated save behind autosave and ⌘S. Returns false when held off; a
     *  valid buffer with nothing new to write still returns true, so ⌘S on it
     *  still commits. */
    const save = async (): Promise<boolean> => {
      const view = viewRef.current
      if (view === null || disposed) return false
      const text = view.state.doc.toString()
      // Hold the save while the buffer is syntactically broken, so a half-typed
      // `tags: [` is never the committed state. Markdown gates on its
      // frontmatter YAML; a plain file on its own language (`syntaxValid`).
      if (plain ? !syntaxValid(path, text) : !frontmatterValid(view.state)) return false
      if (hasNewText(baseRef.current, text, path, normalizers.current)) {
        baseRef.current = text
        await trpc.notes.write.mutate({ remote, path, text })
      }
      return true
    }

    const scheduleSave = () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void save(), SAVE_QUIET_MS)
    }

    void trpc.notes.read.query({ remote, path }).then((text) => {
      if (disposed) return
      baseRef.current = text
      const view = new EditorView({
        state: EditorState.create({
          doc: text,
          // Open the caret in the body, below the frontmatter widget. `assoc: 1`
          // binds it to the body side of the seam.
          selection: EditorSelection.cursor(plain ? 0 : bodyStart(text), 1),
          extensions: [
            ...(plain
              ? plainTextExtensions(path, readOnly)
              : baseEditorExtensions({
                  docExists: (p) => docPaths.current.has(p),
                  taskByPath: (p) => {
                    const t = tasksByPath.current.get(p)
                    return t ? { title: t.title, status: t.status, due: t.due } : null
                  },
                  readNote: (p) =>
                    trpc.notes.read.query({ remote, path: p }).then(
                      (text) => text,
                      () => null,
                    ),
                  mentionData: () => mentionRef.current,
                  nav: () => navRef.current,
                  ...(hasAgent
                    ? {
                        askAgent: {
                          targets: () =>
                            askAgentRef.current?.targets() ?? { sessions: [], initial: 'new' },
                          onAsk: (prompt, target) =>
                            askAgentRef.current?.onAsk(prompt, target) ?? Promise.resolve(NO_AGENT),
                        },
                      }
                    : {}),
                  notePath: path,
                  readOnly,
                })),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return
              scheduleSave()
              if (!editedRef.current) {
                editedRef.current = true
                onEdit?.()
              }
            }),
          ],
        }),
        parent: host,
      })
      viewRef.current = view
      // Fade in when the document arrives, after the IPC read, not when the
      // tab changed. Opacity only: anything that changes the layout box drags
      // CodeMirror's measure loop into every frame.
      playOnce(host, 'motion-in-fade')
      view.focus()

      if (!plain) unfollow = followCommit(view, path, store)
    })

    // Window blur is a flush point, as is the unmount below (tab close, vault
    // switch). Both use the unconditional flush.
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)

    // The unconditional writer for flush points, and the gated one for ⌘S,
    // which the Shell fires for every open buffer at once.
    const unregister = registerBuffer(flush, async () => void (await save()))

    return () => {
      disposed = true
      unfollow()
      window.removeEventListener('blur', onBlur)
      unregister()
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      // Flush before tearing down: the buffer does not survive a tab close.
      const view = viewRef.current
      if (view !== null) {
        const text = view.state.doc.toString()
        if (hasNewText(baseRef.current, text, path, normalizers.current)) {
          void trpc.notes.write.mutate({ remote, path, text })
        }
        view.destroy()
      }
      viewRef.current = null
    }
    // `readOnly` rebuilds the view: entering a reconcile re-reads the file, so
    // you see the markers the agent is working on. So does an agent coming or
    // going, which adds or drops the Ask button. The teardown flushes first.
  }, [path, remote, plain, readOnly, store, hasAgent])

  /**
   * The vault changed somewhere: re-read our own file and decide. The snapshot
   * carries no path, so this runs on every change; `decideReload` returns
   * `none` for nearly all of them, including this editor's own save.
   */
  useEffect(() => {
    if (path === null || remote === null) return
    let cancelled = false
    void trpc.notes.read.query({ remote, path }).then((disk) => {
      const view = viewRef.current
      if (cancelled || view === null) return
      const decision = decideReload(
        baseRef.current,
        view.state.doc.toString(),
        disk,
        path,
        normalizers.current,
      )
      if (decision.kind === 'none') return
      if (decision.kind === 'conflict') {
        // Both ways out close over the two texts that disagreed, so neither
        // re-reads anything that may have moved since.
        return onConflict(path, {
          keepMine: async () => {
            const mine = view.state.doc.toString()
            baseRef.current = mine
            await trpc.notes.write.mutate({ remote, path, text: mine })
          },
          takeDisk: () => {
            baseRef.current = disk
            applyReload(view, disk)
          },
        })
      }
      // Our own commit-time tidy. `base` catches up to disk; the buffer is not
      // touched, so keystrokes typed while the hook ran survive. The pending
      // save writes them.
      if (decision.kind === 'rebase') {
        baseRef.current = decision.text
        return
      }
      // A clean reload and a merge both replace the buffer and advance `base`;
      // a merge is then written back.
      baseRef.current = decision.text
      applyReload(view, decision.text)
      if (decision.kind === 'merged') {
        void trpc.notes.write.mutate({ remote, path, text: decision.text })
      }
    })
    return () => {
      cancelled = true
    }
  }, [snapshot, path, remote, onConflict])

  if (path === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        select or create a note
      </div>
    )
  }
  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
}
