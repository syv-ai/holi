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
import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { baseEditorExtensions } from '../editor/extensions'
import { bodyStart, frontmatterValid } from '../editor/frontmatter'
import type { LinkNav } from '../editor/links'
import type { MentionData } from '../editor/mentions'
import { registerBuffer } from '../lib/buffer-registry'
import { decideReload } from '../lib/editor-reload'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom, snapshotAtom } from '../state/vaults'

/** Quiet before the buffer reaches disk. Shorter than main's commit debounce on
 *  purpose: the file has to be there before the commit timer decides to look. */
const SAVE_QUIET_MS = 600

export function EditorPane({
  path,
  onOpenNote,
  onConflict,
  onEdit,
}: {
  path: string | null
  onOpenNote: (path: string) => void
  onConflict: (path: string) => void
  /** Fired the first time the buffer changes for this open note — the rule that
   *  promotes a preview tab to pinned (FR-15), so editing never loses your place. */
  onEdit?: () => void
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

  // Read on demand by the editor's pull-based seams, so a snapshot arriving
  // mid-edit does not rebuild the EditorView and drop the caret.
  const docPaths = useRef(new Set<string>())
  docPaths.current = new Set(snapshot.docs.map((d) => d.path))
  const mentionRef = useRef<MentionData>({ notes: [], tasks: [] })
  mentionRef.current = { notes: snapshot.docs.map((d) => ({ path: d.path })), tasks: [] }
  const navRef = useRef<LinkNav>({ openNote: () => {}, openTask: () => {}, openExternal: () => {} })
  navRef.current = {
    // A link can point at a note that does not exist yet; the chip already
    // renders it as missing, so a click does nothing rather than inventing one.
    openNote: (target) => docPaths.current.has(target) && onOpenNote(target),
    openTask: () => {},
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
      if (!frontmatterValid(view.state)) return false
      const text = view.state.doc.toString()
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
          // the body line rather than to the widget's side of the seam.
          selection: EditorSelection.cursor(bodyStart(text), 1),
          extensions: [
            ...baseEditorExtensions({
              docExists: (p) => docPaths.current.has(p),
              taskInfo: () => ({ label: 'task', missing: true }),
              mentionData: () => mentionRef.current,
              onTaskMention: () => {},
              nav: () => navRef.current,
            }),
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
      view.focus()
    })

    // ⌘S is a real commit point, not a placebo (FR-4): it writes, then asks
    // main to commit rather than waiting out the idle timer. Invalid frontmatter
    // holds off both — no write, no commit — until the YAML parses again.
    //
    // It also pushes: ⌘S is an explicit "save this", so getting it off-machine
    // matches the intent (D61). The commit must resolve before the push, or the
    // push races ahead of the very edit ⌘S just committed.
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save().then((ok) => {
          if (ok) void trpc.sync.commitNow.mutate().then(() => trpc.sync.pushNow.mutate())
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // FR-6: window blur is a flush point. So is the unmount below, which covers
    // tab close and vault switch. Both use the unconditional flush — a blur or a
    // tab-close must not drop keystrokes just because the YAML is mid-edit.
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)

    const unregister = registerBuffer(flush)

    return () => {
      disposed = true
      window.removeEventListener('keydown', onKeyDown)
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
  }, [path, remote])

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
      const decision = decideReload(baseRef.current, view.state.doc.toString(), disk)
      if (decision.kind === 'none') return
      if (decision.kind === 'conflict') return onConflict(path)
      // A clean reload and a successful merge both replace the buffer and both
      // advance `base` — the merged text is now what this editor last saw, even
      // though it is not yet what is on disk. The pending save writes it.
      baseRef.current = decision.text
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: decision.text },
      })
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
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        select or create a note
      </div>
    )
  }
  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />
}
