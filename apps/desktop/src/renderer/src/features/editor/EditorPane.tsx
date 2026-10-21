/**
 * One note, one buffer, one file: an autosave that writes the buffer, and
 * `decideReload` for when the file changes underneath. Concurrent editing is
 * deferred (`vision.md`).
 *
 * `base` is the text this editor last loaded or saved. Advancing it on save
 * makes the editor's own write a non-event: by the time the watcher reports
 * it, `disk === base`. The decision lives in `lib/editor-reload.ts`.
 *
 * `@` completes notes and what claims offer (open tasks); each inserts an
 * ordinary path wiki-link.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { anchorAt, findHeadingLine, isCommentableNote, isResolved } from '@holi/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useEffect, useRef } from 'react'
import {
  baseEditorExtensions,
  plainTextExtensions,
  reconfigureClaimLayer,
} from '@/editor/extensions'
import {
  setActiveThread,
  setCommentThreads,
  threadLines,
  threadRange,
} from '@/editor/comment-threads'
import { bodyStart, frontmatterValid, setFrontmatterCommit } from '@/editor/frontmatter'
import { syntaxValid } from '@/editor/languages'
import { playOnce } from '@/lib/motion'
import { applyReload } from '@/lib/apply-reload'
import { registerBuffer } from '@/lib/buffer-registry'
import { decideReload, hasNewText, type ConflictResolvers } from '@/lib/editor-reload'
import { selectedLines } from '@/editor/askAgent'
import { caretHeading } from '@/editor/caret-heading'
import { headingRequestAtom, quietOpenAtom } from '@/state/arrival'
import { caretHeadingAtom } from '@/state/holi-link'
import { useEditorDeps } from '@/state/editor-deps'
import { historyOpenAtom } from '@/state/history'
import {
  activeThreadAtom,
  draftCommentAtom,
  refreshThreadsAtom,
  claimSelectionCommenter,
  threadLinesAtom,
  threadsByPathAtom,
} from '@/state/comments'
import { claimsAtom, normalizersAtom } from '@/state/plugins'
import { trpc } from '@/lib/trpc'
import { fileHistoryAtom } from '@/state/file-history'
import { editorSelectionAtom } from '@/state/ui-report'
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

/**
 * The note's comment threads, into `view`, now and whenever they are read
 * again; the thread the drawer is on, marked and scrolled to; and where each
 * thread is in the buffer, back out to the drawer whenever that moves.
 * Returns the unsubscribe.
 */
function followThreads(view: EditorView, path: string, store: JotaiStore): () => void {
  const push = () => {
    const threads = store.get(threadsByPathAtom)[path] ?? []
    view.dispatch({
      effects: setCommentThreads.of(
        threads.map((t) => ({ id: t.id, anchor: t.anchor, resolved: isResolved(t) })),
      ),
    })
  }
  const focus = () => {
    const active = store.get(activeThreadAtom)
    const id = active?.path === path ? active.id : null
    const range = id === null ? null : threadRange(view.state, id)
    view.dispatch({
      effects: [
        setActiveThread.of(id),
        ...(range === null ? [] : [EditorView.scrollIntoView(range.from, { y: 'center' })]),
      ],
    })
  }
  const offThreads = store.sub(threadsByPathAtom, push)
  const offActive = store.sub(activeThreadAtom, focus)
  push()
  return () => {
    offThreads()
    offActive()
  }
}

/** Tell the drawer where each thread is, when that changed. */
function reportLines(view: EditorView, path: string, store: JotaiStore): void {
  const lines = threadLines(view.state)
  const was = store.get(threadLinesAtom)[path]
  if (was !== undefined && JSON.stringify(was) === JSON.stringify(lines)) return
  store.set(threadLinesAtom, (prev) => ({ ...prev, [path]: lines }))
}

export function EditorPane({
  path,
  onOpenNote,
  onConflict,
  onEdit,
  focused = false,
  plain = false,
  readOnly = false,
}: {
  path: string | null
  /** Whether this editor's pane is the focused one: the pane an arrival opens
   *  in, so the one that takes its heading (`headingRequestAtom`). */
  focused?: boolean
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
  /** Read when a heading request arrives (`goToRequestedHeading`). */
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  /** The open editor's `goToRequestedHeading`, for the pane gaining focus. */
  const goToHeadingRef = useRef<() => void>(() => {})

  const setHistoryOpen = useSetAtom(historyOpenAtom)
  const refreshThreads = useSetAtom(refreshThreadsAtom)
  const draftComment = useSetAtom(draftCommentAtom)
  const draftCommentRef = useRef(draftComment)
  draftCommentRef.current = draftComment
  /** A note that takes threads (`isCommentableNote`), not a plain text file. */
  const claims = useAtomValue(claimsAtom)
  const commentable = path !== null && !plain && isCommentableNote(path, claims)
  /** Read on demand by the editor's pull-based seams, so a snapshot arriving
   *  mid-edit does not rebuild the EditorView and drop the caret. Whether
   *  there is an agent at all does rebuild it, below. */
  const deps = useEditorDeps(path ?? '', {
    openNote: onOpenNote,
    // Open, never toggle. Focus first: the sidebar follows the active pane, a
    // pane activates on focus, and the link's mousedown is prevented, so in a
    // split the press alone would open the other pane's history.
    openHistory: () => {
      viewRef.current?.focus()
      setHistoryOpen(true)
    },
  })
  const depsRef = useRef(deps)
  depsRef.current = deps
  const hasAgent = deps.askAgent !== undefined

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

    /** The selected lines, for the agent's per-turn focus line. Set only when
     *  they change, so typing on one line reports nothing. */
    const reportSelection = (state: EditorState): void => {
      const lines = selectedLines(state)
      const current = store.get(editorSelectionAtom)
      const same =
        lines === null
          ? current === null || current.path !== path
          : current?.path === path &&
            current.lines.startLine === lines.startLine &&
            current.lines.endLine === lines.endLine
      if (!same) store.set(editorSelectionAtom, lines === null ? null : { path, lines })
    }

    /** The heading the caret is on, for the palette's "Copy Holi link to this
     *  heading". Set only when it changes. */
    const reportCaretHeading = (state: EditorState): void => {
      const heading = caretHeading(state)
      const current = store.get(caretHeadingAtom)
      // Off a heading, clear only this note's: another editor's still stands.
      const same =
        heading === null
          ? current === null || current.path !== path
          : current?.path === path && current.heading === heading
      if (!same) store.set(caretHeadingAtom, heading === null ? null : { path, heading })
    }

    /** A Holi link's heading (`headingRequestAtom`), when it is for this note
     *  in the focused pane: the caret to its line, scrolled to the top. Taken
     *  once; a heading that is not there leaves the note where it opened. */
    const goToRequestedHeading = (): void => {
      const view = viewRef.current
      const request = store.get(headingRequestAtom)
      if (view === null || disposed || !focusedRef.current) return
      if (request === null || request.path !== path) return
      store.set(headingRequestAtom, null)
      const line = findHeadingLine(view.state.doc.toString(), request.heading)
      if (line === null) return
      const at = view.state.doc.line(line).from
      view.dispatch({
        selection: EditorSelection.cursor(at),
        effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }),
      })
      view.focus()
    }
    goToHeadingRef.current = goToRequestedHeading
    const offHeadingRequest = store.sub(headingRequestAtom, goToRequestedHeading)

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
                  ...depsRef.current,
                  ...(commentable
                    ? {
                        comment: {
                          comment: (from, to) => {
                            const doc = viewRef.current?.state.doc.toString()
                            if (doc === undefined) return
                            draftCommentRef.current({ path, anchor: anchorAt(doc, from, to) })
                          },
                        },
                      }
                    : {}),
                  readOnly,
                })),
            EditorView.updateListener.of((update) => {
              if (update.selectionSet || update.docChanged) {
                reportSelection(update.state)
                reportCaretHeading(update.state)
              }
              if (commentable) {
                const moved =
                  update.docChanged ||
                  update.transactions.some((tr) => tr.effects.some((e) => e.is(setCommentThreads)))
                if (moved) reportLines(update.view, path, store)
              }
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
      // A fresh editor opens on a caret: whatever this path had selected before
      // is gone.
      reportSelection(view.state)
      reportCaretHeading(view.state)
      // Fade in when the document arrives, after the IPC read, not when the
      // tab changed. Opacity only: anything that changes the layout box drags
      // CodeMirror's measure loop into every frame.
      playOnce(host, 'motion-in-fade')
      // Not when a screenshot opened it: the caret stays where the person is.
      if (store.get(quietOpenAtom) !== path) view.focus()

      if (!plain) {
        const offCommit = followCommit(view, path, store)
        const offThreads = commentable ? followThreads(view, path, store) : () => {}
        // The palette's Comment on selection reaches the editor last focused.
        const commenter = () => {
          const { from, to, empty } = view.state.selection.main
          if (empty || view.state.readOnly) return false
          draftCommentRef.current({ path, anchor: anchorAt(view.state.doc.toString(), from, to) })
          return true
        }
        let release = () => {}
        const claim = () => {
          release = claimSelectionCommenter(commenter)
        }
        if (commentable) {
          view.contentDOM.addEventListener('focus', claim)
          if (store.get(quietOpenAtom) !== path) claim()
        }
        unfollow = () => {
          offCommit()
          offThreads()
          view.contentDOM.removeEventListener('focus', claim)
          release()
        }
      }
      goToRequestedHeading()
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
      offHeadingRequest()
      if (store.get(caretHeadingAtom)?.path === path) store.set(caretHeadingAtom, null)
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
  }, [path, remote, plain, readOnly, store, hasAgent, commentable])

  /**
   * The note's comment threads, read again whenever the vault changes: a pull
   * or the agent may have written them. The snapshot carries no path, so this
   * runs on every change, like the reload below.
   */
  useEffect(() => {
    if (path === null || !commentable) return
    void refreshThreads(path)
  }, [snapshot, path, commentable, refreshThreads])

  // An arrival into the pane beside the agent focuses that pane after asking
  // for the heading, so an editor already showing the note takes it now.
  useEffect(() => {
    if (focused) goToHeadingRef.current()
  }, [focused])

  // The file's claim came or went (its plugin turned on or off): the open
  // view takes the new claim layer in place, caret and undo kept.
  const { frontmatterAlwaysOpen, claimExtensions } = deps
  useEffect(() => {
    const view = viewRef.current
    if (view !== null) reconfigureClaimLayer(view, depsRef.current)
  }, [frontmatterAlwaysOpen, claimExtensions])

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
