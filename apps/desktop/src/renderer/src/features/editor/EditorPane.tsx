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
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { snapshotTasks, type Task } from '@holi/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { baseEditorExtensions, plainTextExtensions } from '@/editor/extensions'
import { bodyStart, frontmatterValid, setFrontmatterCommit } from '@/editor/frontmatter'
import { syntaxValid } from '@/editor/languages'
import type { LinkNav } from '@/editor/links'
import type { MentionData } from '@/editor/mentions'
import { applyReload } from '@/lib/apply-reload'
import { registerBuffer } from '@/lib/buffer-registry'
import { decideReload, hasNewText, type ConflictResolvers } from '@/lib/editor-reload'
import { NO_AGENT, useAskAgentSeam } from '@/state/agent-service'
import { historyOpenAtom } from '@/state/history'
import { normalizersAtom } from '@/state/plugins'
import { trpc } from '@/lib/trpc'
import { fileHistoryAtom } from '@/state/file-history'
import { OutlineRail } from './OutlineRail'
import { BlockGutter } from './BlockGutter'
import { PageActions } from './PageActions'
import { Button, toast } from '@/primitives'
import { runCommandAtom } from '@/state/commands'
import { notePageAtom, NOTE_PAGE_DEFAULTS, type NotePage } from '@/state/note-page'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'

/** Quiet before the buffer reaches disk. Shorter than main's commit debounce on
 *  purpose: the file has to be there before the commit timer decides to look. */
const SAVE_QUIET_MS = 600

/** Below this the outline rail would sit on the text: the page actions carry
 *  the outline as a button instead. */
const RAIL_MIN_WIDTH = 640

/** How long a notice with Undo stays (WCAG 2.2.1: long enough to reach it). */
const NOTICE_MS = 8000

/** A read slower than this shows the skeleton; a quick one shows nothing. */
const SKELETON_AFTER_MS = 150

/**
 * A note's page toggles as editor extensions (docs/features/editor.md): full
 * width lifts the column's cap, small text sets the page a step down, and a
 * lock makes the document read-only. `Prec.highest`, since the first
 * `readOnly`/`editable` value is the one that counts.
 */
function pageExtensions(page: NotePage): Extension {
  return [
    page.locked ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)]) : [],
    page.fullWidth
      ? EditorView.theme({ '& > .cm-scroller > .cm-content': { maxWidth: 'none' } })
      : [],
    page.smallText ? EditorView.theme({ '& .cm-content': { fontSize: '0.875em' } }) : [],
  ]
}

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
  /** The positioned box the gutter and the page actions sit in. */
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const frameRef = useCallback((el: HTMLDivElement | null) => setFrame(el), [])
  /** Whether the frame is too narrow for the outline rail. */
  const [narrow, setNarrow] = useState(false)
  /** A write is pending or in flight; the page actions say "Saving…". */
  const [saving, setSaving] = useState(false)
  /** The read is taking long enough to show the page's shape. */
  const [slow, setSlow] = useState(false)
  /** What just happened, with a way back: the shell's one toaster, whose live
   *  region exists before the message does, so it is announced. */
  const showNotice = useCallback((message: string, undo?: () => void) => {
    toast(message, {
      duration: NOTICE_MS,
      ...(undo === undefined ? {} : { action: { label: 'Undo', onClick: undo } }),
    })
  }, [])
  const runCommand = useSetAtom(runCommandAtom)
  /** This note's page toggles, machine-local (`state/note-page.ts`). */
  const pageAtom = notePageAtom(remote ?? '', path ?? '')
  const page = useAtomValue(pageAtom)
  const setPage = useSetAtom(pageAtom)
  const pageRef = useRef<NotePage>(NOTE_PAGE_DEFAULTS)
  pageRef.current = page
  const pageCompartment = useRef(new Compartment())
  /** Space on an empty line asks the agent: read at the keypress. */
  const settings = useAtomValue(vaultSettingsAtom)
  const spaceAsks = useRef(true)
  spaceAsks.current = settings?.settings.spaceAsksAgent ?? VAULT_SETTING_DEFAULTS.spaceAsksAgent

  /** The text last loaded or saved; advanced by the save before the watcher
   *  reports it. */
  const baseRef = useRef('')
  const viewRef = useRef<EditorView | null>(null)
  /** The same view as state, for what renders beside it (the outline rail). */
  const [shownView, setShownView] = useState<EditorView | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether `onEdit` has fired for this open note; reset per open. */
  const editedRef = useRef(false)

  // Read on demand by the editor's pull-based seams, so a snapshot arriving
  // mid-edit does not rebuild the EditorView and drop the caret.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshotTasks(snapshot).items.map((t) => [t.path, t]))
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
      if (!plain) setSaving(true)
      saveTimer.current = setTimeout(
        () =>
          void save().then(
            // Held off (broken frontmatter) is not saved: it stays "Saving…"
            // until the YAML parses and the next save lands.
            (done) => !disposed && done && setSaving(false),
            () => !disposed && setSaving(false),
          ),
        SAVE_QUIET_MS,
      )
    }
    setSaving(false)
    setSlow(false)
    const slowTimer = setTimeout(() => !disposed && setSlow(true), SKELETON_AFTER_MS)

    void trpc.notes.read.query({ remote, path }).then((text) => {
      clearTimeout(slowTimer)
      if (disposed) return
      setSlow(false)
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
                  spaceAsksAgent: () => spaceAsks.current,
                })),
            // The page menu's toggles; reconfigured when they change.
            pageCompartment.current.of(plain ? [] : pageExtensions(pageRef.current)),
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
      if (!plain) setShownView(view)
      // No fade on arrival: opening a note is the most frequent action, often
      // from the keyboard, and it should land at once.
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
      clearTimeout(slowTimer)
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
      setShownView(null)
    }
    // `readOnly` rebuilds the view: entering a reconcile re-reads the file, so
    // you see the markers the agent is working on. So does an agent coming or
    // going, which adds or drops the Ask button. The teardown flushes first.
  }, [path, remote, plain, readOnly, store, hasAgent])

  // A page toggle reaches the open editor without rebuilding it.
  useEffect(() => {
    if (shownView === null) return
    shownView.dispatch({ effects: pageCompartment.current.reconfigure(pageExtensions(page)) })
  }, [page, shownView])

  // The rail needs a margin to sit in; a narrow pane gets the outline button.
  useEffect(() => {
    if (frame === null) return
    const observer = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? frame.clientWidth) < RAIL_MIN_WIDTH)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frame])

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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        No note open
        <Button variant="outline" size="sm" onClick={() => void runCommand('note.new')}>
          New note
        </Button>
      </div>
    )
  }
  const title = path.split('/').pop()?.replace(/\.md$/, '') ?? path
  return (
    <div ref={frameRef} className="relative flex min-w-0 flex-1 overflow-hidden">
      <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
      {slow && shownView === null && !plain && <PageSkeleton />}
      {!narrow && <OutlineRail view={shownView} />}
      {shownView !== null && frame !== null && (
        <>
          <BlockGutter view={shownView} container={frame} onNotice={showNotice} />
          <div className="absolute top-2 right-4 z-20">
            <PageActions
              view={shownView}
              title={title}
              page={page}
              onPageChange={setPage}
              saving={saving}
              showOutline={narrow}
              onNotice={showNotice}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** The page's shape while a slow read finishes (after ReUI's editor skeleton):
 *  a title and two paragraphs, in the column the note will take. */
function PageSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="absolute inset-0 flex justify-center px-6 pt-8">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex flex-col gap-4">
          <div className="h-8 w-2/3 rounded-md motion-shimmer" />
          <div className="flex flex-col gap-2.5">
            <div className="h-4 w-full rounded-md motion-shimmer" />
            <div className="h-4 w-11/12 rounded-md motion-shimmer" />
            <div className="h-4 w-3/5 rounded-md motion-shimmer" />
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="h-6 w-1/4 rounded-md motion-shimmer" />
          <div className="flex flex-col gap-2.5">
            <div className="h-4 w-5/6 rounded-md motion-shimmer" />
            <div className="h-4 w-3/4 rounded-md motion-shimmer" />
          </div>
        </div>
      </div>
    </div>
  )
}
