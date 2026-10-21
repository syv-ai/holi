/**
 * The passages a note's comment threads are about, marked in the editor
 * (docs/features/note-comments.md). Not the `<!-- -->` banners: those are
 * `comments.ts`, text in the note itself. These threads live in a sidecar the
 * note never sees, so they arrive as an effect and are placed in the buffer
 * here.
 *
 * A thread is placed once when its threads arrive (`locateAnchor`, the same
 * rules `holi comments` uses), then follows edits through CodeMirror's own
 * position mapping, so typing inside or around a passage carries its mark
 * along. A passage deleted outright is detached until the threads arrive
 * again, which is the next time anything in the vault changes.
 *
 * Only open threads are marked; the panel lists the resolved ones.
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { locateAnchor, type CommentAnchor } from '@holi/shared'

export interface EditorThread {
  id: string
  anchor: CommentAnchor
  resolved: boolean
}

/** The note's threads, as the panel has them. */
export const setCommentThreads = StateEffect.define<readonly EditorThread[]>()

/** The thread the panel is on, marked stronger; null for none. */
export const setActiveThread = StateEffect.define<string | null>()

interface Placed {
  thread: EditorThread
  /** Null while detached. */
  range: { from: number; to: number } | null
}

interface ThreadsState {
  placed: readonly Placed[]
  active: string | null
}

const place = (state: EditorState, threads: readonly EditorThread[]): Placed[] => {
  const doc = state.doc.toString()
  return threads.map((thread) => ({ thread, range: locateAnchor(doc, thread.anchor) }))
}

export const commentThreadsField = StateField.define<ThreadsState>({
  create: () => ({ placed: [], active: null }),
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      next = {
        ...next,
        placed: next.placed.map((p) => {
          if (p.range === null) return p
          const from = tr.changes.mapPos(p.range.from, 1)
          const to = tr.changes.mapPos(p.range.to, -1)
          return { ...p, range: from < to ? { from, to } : null }
        }),
      }
    }
    for (const e of tr.effects) {
      if (e.is(setCommentThreads)) next = { ...next, placed: place(tr.state, e.value) }
      if (e.is(setActiveThread)) next = { ...next, active: e.value }
    }
    return next
  },
  provide: (field) =>
    EditorView.decorations.from(field, ({ placed, active }): DecorationSet => {
      const marks = placed
        .filter((p) => p.range !== null && !p.thread.resolved)
        .map((p) =>
          Decoration.mark({
            class:
              p.thread.id === active
                ? 'cm-thread-anchor cm-thread-anchor-active'
                : 'cm-thread-anchor',
            attributes: { 'data-thread': p.thread.id },
          }).range(p.range!.from, p.range!.to),
        )
      return Decoration.set(marks, true)
    }),
})

/** Each thread's line in the buffer now (1-based), or null while detached. */
export function threadLines(state: EditorState): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const p of state.field(commentThreadsField, false)?.placed ?? []) {
    out[p.thread.id] = p.range === null ? null : state.doc.lineAt(p.range.from).number
  }
  return out
}

/** Where thread `id` is in the buffer, or null. */
export function threadRange(state: EditorState, id: string): { from: number; to: number } | null {
  return (
    state.field(commentThreadsField, false)?.placed.find((p) => p.thread.id === id)?.range ?? null
  )
}

export const commentThreads: Extension = commentThreadsField
