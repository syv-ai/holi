/**
 * One note, one buffer, one file.
 *
 * The CRDT is gone and nothing replaced it: `yCollab`, the awareness channel
 * and the presence colours all served concurrent editing, which is deferred
 * (`vision.md`). What replaced it is much smaller — an autosave that writes the
 * buffer, and `decideReload` for when the file changes underneath.
 *
 * **`base` is the text this editor last loaded or saved**, and advancing it on
 * save is what makes the editor's own write a non-event: by the time the
 * watcher reports it, `disk === base`. See `lib/editor-reload.ts`, which is
 * where that decision actually lives.
 *
 * Task mentions are **not** wired here. The mention layer still writes
 * `[[task:<id>]]`, and a task link is an ordinary path wiki-link now
 * (`glossary.md` §Task — "there are no opaque task ids"). Rather than emit
 * links in a grammar the product has abandoned, `@` completes notes only until
 * the tasks surface returns.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Task } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { baseEditorExtensions, plainTextExtensions } from '@/editor/extensions'
import { bodyStart, frontmatterValid, setFrontmatterCommit } from '@/editor/frontmatter'
import { syntaxValid } from '@/editor/languages'
import type { AskAgentSeam } from '@/editor/askAgent'
import type { LinkNav } from '@/editor/links'
import type { MentionData } from '@/editor/mentions'
import { playOnce, prefersReducedMotion } from '@/lib/motion'
import { applyReload } from '@/lib/apply-reload'
import { registerBuffer } from '@/lib/buffer-registry'
import { decideReload, type ConflictResolvers } from '@/lib/editor-reload'
import { askTargetsAtom, defaultAgentTargetAtom } from '@/state/agent'
import { sendToAgentAtom } from '@/state/agent-send'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/** Quiet before the buffer reaches disk. Shorter than main's commit debounce on
 *  purpose: the file has to be there before the commit timer decides to look. */
const SAVE_QUIET_MS = 600

/** On the host while the column is sliding between its two anchors. `index.css`
 *  §Solo note column has the animation it switches on. */
const COLUMN_SLIDING = 'holi-column-sliding'

/**
 * Where the column's left edge is laid out on screen, ignoring any slide in
 * flight: `offsetLeft` is layout, and a transform is not. Read against the
 * offset parent's rect so a pane that moved (a split, the explorer) is counted.
 */
function columnLeft(view: EditorView): number | null {
  const content = view.contentDOM
  const parent = content.offsetParent
  return parent === null ? null : parent.getBoundingClientRect().left + content.offsetLeft
}

/**
 * Redraw the caret and the selection where the column now is.
 *
 * CodeMirror draws both in layers beside the content, at positions it measured,
 * and it re-measures them when the editor's WIDTH changes. A column that moves
 * inside an editor of the same width (a second tab opening, not a split) changes
 * nothing it checks, so the caret stays where the text used to be. Setting the
 * selection to itself is the one update both layers answer to.
 */
function redrawLayers(view: EditorView): void {
  view.dispatch({ selection: view.state.selection })
}

/**
 * Move the column to its anchor, sliding it in from `from` when there is a
 * distance to cover. Returns where it is now laid out, for the next slide.
 *
 * A FLIP: the margin has already changed and the column is already laid out at
 * its new anchor; `index.css` §Solo note column plays a transform from `from`.
 * The caret and selection layers are hidden for the trip and redrawn where the
 * column lands (the host's `animationend`, in `EditorPane`), because a measure
 * mid-slide would pin them to wherever the transform happened to be.
 */
function slideColumn(host: HTMLElement, view: EditorView, from: number | null): number | null {
  const to = columnLeft(view)
  // Removed on both paths: it also ends a slide that was sent back before it
  // arrived, which would otherwise leave the layers hidden.
  host.classList.remove(COLUMN_SLIDING)
  if (from === null || to === null || Math.abs(from - to) < 1 || prefersReducedMotion()) {
    redrawLayers(view)
    return to
  }
  host.style.setProperty('--column-from', `${from - to}px`)
  // Not `playOnce`: its listener waits for an animation on the host itself, and
  // this one runs on the content inside it. The reflow is the same restart.
  void host.offsetWidth
  host.classList.add(COLUMN_SLIDING)
  return to
}

export function EditorPane({
  path,
  onOpenNote,
  onConflict,
  onEdit,
  plain = false,
  readOnly = false,
  centred = false,
}: {
  path: string | null
  onOpenNote: (path: string) => void
  onConflict: (path: string, resolve: ConflictResolvers) => void
  /** Fired the first time the buffer changes for this open note — the rule that
   *  promotes a preview tab to pinned (FR-15), so editing never loses your place. */
  onEdit?: () => void
  /** A non-markdown text file: swap in the plain editing stack, open the caret at
   *  the top, and never hold off the save on frontmatter (it has none). The
   *  save/flush/reload machinery is otherwise identical. */
  plain?: boolean
  /** A reconcile is resolving this file (`../../../main/vault/active-vault`
   *  FR-19). The document opens locked — the markers in it belong to the merge,
   *  and a keystroke landing between the agent's read and its write is a
   *  resolution built on a file that moved. */
  readOnly?: boolean
  /** One note is the only thing open (`isSoloNote`): centre the column, and
   *  slide it when that starts or stops (#13). */
  centred?: boolean
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const hostRef = useRef<HTMLDivElement>(null)

  /** The text last loaded or saved. The whole write-attribution design rests on
   *  this being advanced by the save, before the watcher reports it. */
  const baseRef = useRef('')
  const viewRef = useRef<EditorView | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether `onEdit` has fired for this open note — reset per open, so the
   *  promote-on-edit rule fires once, not once per keystroke. */
  const editedRef = useRef(false)
  /** Where the column was last laid out on screen, for its slide (see below). */
  const columnFrom = useRef<number | null>(null)
  /** The path the current view was built for, and whether a change of anchor
   *  is waiting for the next view to be built to play (see below). */
  const viewPath = useRef<string | null>(null)
  const slidePending = useRef(false)

  // Read on demand by the editor's pull-based seams, so a snapshot arriving
  // mid-edit does not rebuild the EditorView and drop the caret.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const tasksByPath = useRef(new Map<string, Task>())
  tasksByPath.current = new Map(snapshot.tasks.map((t) => [t.path, t]))
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = {
    notes: snapshot.docs.map((d) => ({
      path: d.path,
      ...(snapshot.icons[d.path] === undefined ? {} : { icon: snapshot.icons[d.path] }),
    })),
    tasks: snapshot.tasks.map((t) => ({
      path: t.path,
      title: t.title,
      status: t.status,
      ...(t.due === undefined ? {} : { due: t.due }),
    })),
  }
  const sendToAgent = useSetAtom(sendToAgentAtom)
  const askTargets = useAtomValue(askTargetsAtom)
  const defaultTarget = useAtomValue(defaultAgentTargetAtom)
  /** Held in a ref, exactly as `nav` is: the extension list must not rebuild on
   *  every render, and a seam that closed over a stale list would offer the tabs
   *  that were open three selections ago. */
  const askAgentRef = useRef<AskAgentSeam>({
    targets: () => ({ sessions: [], initial: 'new' }),
    onAsk: () => Promise.resolve({ ok: true }),
  })
  askAgentRef.current = {
    targets: () => ({ sessions: askTargets, initial: defaultTarget }),
    onAsk: (prompt, target) => sendToAgent({ text: prompt, target }),
  }
  const navRef = useRef<LinkNav>({ openNote: () => {}, openExternal: () => {} })
  navRef.current = {
    // A link can point at a note or task that does not exist yet; the chip renders
    // missing and the click no-ops rather than inventing a file.
    openNote: (target) =>
      (docPaths.current.has(target) || tasksByPath.current.has(target)) && onOpenNote(target),
    openExternal: (url) => void window.holi.openExternal(url),
  }

  useEffect(() => {
    if (path === null || remote === null || hostRef.current === null) return
    let disposed = false
    editedRef.current = false
    const host = hostRef.current

    /** Write the buffer if it differs from disk, advancing `base` in the same
     *  breath — the order is the point. **Unconditional:** used by the flush
     *  registry (quit, and rename's pre-flush) and the unmount below, where
     *  losing keystrokes is worse than a note with temporarily-invalid
     *  frontmatter — git has it either way (notes-editor.md §Frontmatter). */
    const flush = async (): Promise<void> => {
      const view = viewRef.current
      if (view === null || disposed) return
      const text = view.state.doc.toString()
      if (text === baseRef.current) return
      baseRef.current = text
      await trpc.notes.write.mutate({ remote, path, text })
    }

    /** The gated save behind autosave and ⌘S: hold off entirely while the
     *  frontmatter YAML is invalid (the FR-16 dot is red), so a half-typed
     *  `tags: [` is never the autosaved — or "committed" — state. Returns
     *  whether the caller may proceed (true when valid, false when held off);
     *  a valid buffer that simply had nothing new to write still returns true,
     *  so ⌘S on it still commits (FR-4). */
    const save = async (): Promise<boolean> => {
      const view = viewRef.current
      if (view === null || disposed) return false
      const text = view.state.doc.toString()
      // Hold the save while the buffer is syntactically broken, so a half-typed
      // config is never the autosaved — or committed — state. Markdown gates on
      // its frontmatter YAML (FR-16); a plain file gates on its own language
      // (`syntaxValid`: JSON/YAML only, everything else always valid). Both let
      // the unconditional `flush` through — a blur or quit still writes, because
      // losing keystrokes is worse than a file with temporarily-invalid syntax.
      if (plain ? !syntaxValid(path, text) : !frontmatterValid(view.state)) return false
      if (text !== baseRef.current) {
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
          // Open the caret in the body, never to the left of the frontmatter
          // widget (there is nothing to edit above it). `assoc: 1` binds it to
          // the body line rather than to the widget's side of the seam. A plain
          // file has no frontmatter widget, so open at the top.
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
                  askAgent: {
                    targets: () => askAgentRef.current.targets(),
                    onAsk: (prompt, target) => askAgentRef.current.onAsk(prompt, target),
                  },
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
      viewPath.current = path
      columnFrom.current = slidePending.current
        ? slideColumn(host, view, columnFrom.current)
        : columnLeft(view)
      slidePending.current = false
      // Arrive when the DOCUMENT does, not when the tab changed.
      //
      // The pane's own fade fires the moment you pick a different tab, but this
      // editor is built after an IPC read — so on a file that was not already
      // open, the fade played out over an empty container and the text appeared
      // afterwards, at full opacity, with nothing to see. Switching between
      // notes already open looked right only because their buffers were warm.
      // Opacity only: this wraps CodeMirror, and anything that changes the
      // layout box drags its measure loop into every frame.
      playOnce(host, 'motion-in-fade')
      view.focus()

      // The collapsed frontmatter summary needs the file's last commit (author +
      // date). Fetch it after the view exists and dispatch it in; a null result
      // (new/untracked file) just leaves the summary at the char count. Guarded
      // so a fast tab switch can't write into a torn-down or replaced view.
      if (!plain) {
        void trpc.notes.lastCommit
          .query({ path })
          .then((commit) => {
            if (disposed || viewRef.current !== view) return
            view.dispatch({ effects: setFrontmatterCommit.of(commit) })
          })
          .catch(() => {})
      }
    })

    // FR-6: window blur is a flush point. So is the unmount below, which covers
    // tab close and vault switch. Both use the unconditional flush — a blur or a
    // tab-close must not drop keystrokes just because the YAML is mid-edit.
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)

    // Both writers: the unconditional one for FR-6's flush points, and the
    // gated one for ⌘S, which the Shell fires for every open buffer at once
    // (FR-4). The gate is what keeps a half-typed `tags: [` out of a commit.
    const unregister = registerBuffer(flush, async () => void (await save()))

    return () => {
      disposed = true
      // A slide still running belongs to this view. Left on the host, it would
      // play again on the next one's content the moment it mounted.
      host.classList.remove(COLUMN_SLIDING)
      window.removeEventListener('blur', onBlur)
      unregister()
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      // Flush before tearing down: this fires on tab close and vault switch,
      // and the buffer is the one thing that does not survive either.
      const view = viewRef.current
      if (view !== null) {
        const text = view.state.doc.toString()
        if (text !== baseRef.current) void trpc.notes.write.mutate({ remote, path, text })
        view.destroy()
      }
      viewRef.current = null
    }
    // `readOnly` rebuilds the view, which is the honest behaviour: entering a
    // reconcile re-reads the file, so the markers the agent is working on are
    // what you see. The teardown flushes first, so a dirty buffer is written
    // before the lock rather than lost to it.
  }, [path, remote, plain, readOnly])

  /**
   * The column's slide between its two anchors (#13).
   *
   * The centring is CSS: `margin-inline: auto` under `data-solo-column`
   * (`index.css` §Solo note column). The margin cannot be what moves, because
   * `auto` does not interpolate and because inside CodeMirror motion is paint
   * only: animating layout drags its measure loop into every frame. So
   * `slideColumn` plays a transform in from where the column was.
   *
   * "Where it was" has to be known before the change, and a layout effect runs
   * after it, often with the pane already narrowed by a split in the same
   * commit. So `columnFrom` keeps the last laid-out position as it goes: when
   * the view is built, after each slide, and whenever the host resizes. The
   * slide plays only on a change of anchor, so dragging the explorer while solo
   * keeps the column centred 1:1 with no easing: only the margin follows it.
   *
   * **Solo usually ends by opening another note**, and then the view on screen
   * is about to be replaced by one that does not exist yet (it is built after
   * an IPC read). Sliding the old one would animate text nobody will see, so
   * the slide waits for the new view and plays from where the old column was:
   * what moves is the column, whichever note is in it.
   */
  const hasHost = path !== null

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const landed = (e: AnimationEvent) => {
      if (e.animationName !== 'holi-column-slide') return
      host.classList.remove(COLUMN_SLIDING)
      const view = viewRef.current
      if (view !== null) redrawLayers(view)
    }
    host.addEventListener('animationend', landed)
    // Absent in jsdom, where there is no layout to follow anyway.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const view = viewRef.current
            if (view !== null) columnFrom.current = columnLeft(view)
          })
    observer?.observe(host)
    return () => {
      host.removeEventListener('animationend', landed)
      observer?.disconnect()
    }
  }, [hasHost])

  const firstAnchor = useRef(true)
  useLayoutEffect(() => {
    if (firstAnchor.current) {
      firstAnchor.current = false
      return
    }
    const host = hostRef.current
    const view = viewRef.current
    if (host === null) return
    if (view === null || viewPath.current !== path) {
      slidePending.current = true
      return
    }
    columnFrom.current = slideColumn(host, view, columnFrom.current)
    // On a change of anchor and nothing else. `path` is read to tell whether the
    // view is about to be replaced; a new path on its own is not a reason to move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centred])

  /**
   * The vault changed somewhere. Re-read our own file and decide.
   *
   * The snapshot push carries no path — it is the whole vault, every time — so
   * this runs on every change to anything. That is cheap and it is correct:
   * `decideReload` returns `none` for the overwhelming majority, including this
   * editor's own save.
   */
  useEffect(() => {
    if (path === null || remote === null) return
    let cancelled = false
    void trpc.notes.read.query({ remote, path }).then((disk) => {
      const view = viewRef.current
      if (cancelled || view === null) return
      const decision = decideReload(baseRef.current, view.state.doc.toString(), disk, path)
      if (decision.kind === 'none') return
      if (decision.kind === 'conflict') {
        // Both ways out are closed over the two texts that actually disagreed,
        // so neither has to re-read anything that may have moved on since.
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
      // Our own commit-time tidy. `base` catches up to disk so the invariant
      // holds again, and the buffer is deliberately NOT touched: the keystrokes
      // that arrived while the hook ran are the whole thing worth protecting
      // here. The pending save writes them, and the next commit re-tidies.
      if (decision.kind === 'rebase') {
        baseRef.current = decision.text
        return
      }
      // A clean reload and a successful merge both replace the buffer and both
      // advance `base` — the merged text is now what this editor last saw, even
      // though it is not yet what is on disk. The pending save writes it.
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
  return (
    <div
      ref={hostRef}
      className="min-w-0 flex-1 overflow-hidden"
      data-solo-column={centred || undefined}
    />
  )
}
