/**
 * A note's comment threads in the renderer (docs/features/note-comments.md).
 *
 * Each open note's editor loads its threads (`refreshThreadsAtom`) when it
 * opens and whenever the vault changes, since a pull or the agent may have
 * written the sidecar; the editor marks the passages and reports where each
 * thread is now (`threadLinesAtom`). The comments drawer shows the focused
 * note's (`commentsTargetPathAtom`).
 */
import { isCommentableNote, type CommentAnchor, type CommentThread } from '@holi/shared'
import { atom, type SetStateAction, type WritableAtom } from 'jotai'
import { trpc } from '../lib/trpc'
import { historyOpenAtom, historyTargetPathAtom } from './history'
import { activeRemoteAtom } from './vaults'

/**
 * State that belongs to the vault it was set in: read in another vault it is
 * `initial` again, so a note at the same path in the next vault never shows
 * the last one's threads: nothing carries from one vault to the next.
 */
function vaultScoped<T>(initial: T): WritableAtom<T, [SetStateAction<T>], void> {
  const held = atom<{ remote: string | null; value: T }>({ remote: null, value: initial })
  const read = atom((get) => {
    const { remote, value } = get(held)
    return remote === get(activeRemoteAtom) ? value : initial
  })
  return atom(
    (get) => get(read),
    (get, set, next: SetStateAction<T>) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(get(read)) : next
      set(held, { remote: get(activeRemoteAtom), value })
    },
  )
}

export const commentsOpenAtom = atom(false)

/** The note the drawer is about: the focused note, as History's, when it
 *  takes comments (`isCommentableNote`). */
export const commentsTargetPathAtom = atom<string | null>((get) => {
  const path = get(historyTargetPathAtom)
  return path === null || !isCommentableNote(path) ? null : path
})

/** Open or close the drawer. It and History share the right edge, so opening
 *  one closes the other. */
export const toggleCommentsAtom = atom(null, (get, set, open?: boolean) => {
  const next = open ?? !get(commentsOpenAtom)
  set(commentsOpenAtom, next)
  if (next) set(historyOpenAtom, false)
})

/** Every loaded note's threads, by path. */
export const threadsByPathAtom = vaultScoped<Record<string, CommentThread[]>>({})

/** Where each of a note's threads is in its open buffer: a 1-based line, or
 *  null while detached. By path, then thread id. */
export const threadLinesAtom = vaultScoped<Record<string, Record<string, number | null>>>({})

/** A thread being written: the passage the selection was on. */
export interface CommentDraft {
  path: string
  anchor: CommentAnchor
}

export const commentDraftAtom = vaultScoped<CommentDraft | null>(null)

/** The thread the drawer is on, which the editor marks and scrolls to.
 *  `seq` makes a second click on the same thread scroll again. */
export const activeThreadAtom = vaultScoped<{ path: string; id: string; seq: number } | null>(null)

export const focusThreadAtom = atom(null, (get, set, target: { path: string; id: string }) => {
  set(activeThreadAtom, { ...target, seq: (get(activeThreadAtom)?.seq ?? 0) + 1 })
})

/**
 * The focused note editor's "comment on what is selected": true when there
 * was a selection to comment on. Registered by whichever note editor last
 * took focus, so the palette, which takes focus itself, still reaches it.
 */
let selectionCommenter: (() => boolean) | null = null

/** Make `fn` the one; the release forgets it, unless another took over. */
export function claimSelectionCommenter(fn: () => boolean): () => void {
  selectionCommenter = fn
  return () => {
    if (selectionCommenter === fn) selectionCommenter = null
  }
}

/** Comment on the focused note's selection; with none, open the drawer. */
export const commentOnSelectionAtom = atom(null, (_get, set) => {
  if (selectionCommenter?.() !== true) set(toggleCommentsAtom, true)
})

/** Read `path`'s threads again. Unchanged threads leave the atom alone, so
 *  the editor does not place every thread again after each save. */
export const refreshThreadsAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const threads = await trpc.comments.list.query({ remote, path }).catch((err: unknown) => {
    console.error('[comments]', err)
    return null
  })
  if (threads === null || get(activeRemoteAtom) !== remote) return
  const was = get(threadsByPathAtom)[path]
  if (was !== undefined && JSON.stringify(was) === JSON.stringify(threads)) return
  set(threadsByPathAtom, (prev) => ({ ...prev, [path]: threads }))
})

/** The focused note's threads, for the drawer. */
export const targetThreadsAtom = atom<CommentThread[]>((get) => {
  const path = get(commentsTargetPathAtom)
  return path === null ? [] : (get(threadsByPathAtom)[path] ?? [])
})

/** Start a thread on a passage: the drawer opens on its composer. */
export const draftCommentAtom = atom(null, (_get, set, draft: CommentDraft) => {
  set(commentDraftAtom, draft)
  set(toggleCommentsAtom, true)
})

export const addCommentAtom = atom(null, async (get, set, body: string) => {
  const draft = get(commentDraftAtom)
  const remote = get(activeRemoteAtom)
  if (draft === null || remote === null) return
  const { thread } = await trpc.comments.add.mutate({
    remote,
    path: draft.path,
    anchor: draft.anchor,
    body,
  })
  set(commentDraftAtom, null)
  await set(refreshThreadsAtom, draft.path)
  set(focusThreadAtom, { path: draft.path, id: thread })
})

export const replyCommentAtom = atom(
  null,
  async (get, set, args: { path: string; thread: string; body: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await trpc.comments.reply.mutate({ remote, ...args })
    await set(refreshThreadsAtom, args.path)
  },
)

export const resolveThreadAtom = atom(
  null,
  async (get, set, args: { path: string; thread: string; resolved: boolean }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await trpc.comments.setResolved.mutate({ remote, ...args })
    await set(refreshThreadsAtom, args.path)
  },
)
