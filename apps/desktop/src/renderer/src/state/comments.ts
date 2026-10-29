/**
 * A note's comment threads in the renderer (docs/features/note-comments.md).
 *
 * The document view loads its note's threads when it opens and again
 * whenever the vault is read again, since a pull or the agent may have
 * written the sidecar. Writes go through `comments.*`, signed by the person
 * signed in, then read the threads again. A note the router says takes no
 * comments (a file a plugin owns, the agent's instructions) is `unavailable`,
 * and shows no comments at all.
 */
import type { CommentAnchor, CommentThread } from '@holi/shared'
import { atom } from 'jotai'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom } from './vaults'

export type ThreadsLoad =
  | { state: 'loading' }
  | { state: 'ready'; threads: CommentThread[] }
  | { state: 'error'; message: string }
  | { state: 'unavailable' }

/** Every loaded note's threads, by vault and path, so a note at the same
 *  path in another vault never shows this one's. */
const loadsAtom = atom<Record<string, ThreadsLoad>>({})

const keyOf = (remote: string, path: string) => `${remote}\n${path}`

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The router's refusal of a file that takes no comments. */
function isRefusal(err: unknown): boolean {
  return /takes no comments/.test(message(err))
}

export const threadsLoadAtom = atom((get) => {
  const loads = get(loadsAtom)
  const remote = get(activeRemoteAtom)
  return (path: string): ThreadsLoad =>
    remote === null ? { state: 'loading' } : (loads[keyOf(remote, path)] ?? { state: 'loading' })
})

/** Read `path`'s threads again. Unchanged threads leave the atom alone, so
 *  the editor does not place them again after each save. */
export const refreshThreadsAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const key = keyOf(remote, path)
  let next: ThreadsLoad
  try {
    next = { state: 'ready', threads: await trpc.comments.list.query({ remote, path }) }
  } catch (err) {
    const was = get(loadsAtom)[key]
    // A failed re-read keeps what was shown; only a first read shows the error.
    if (was?.state === 'ready' && !isRefusal(err)) return
    next = isRefusal(err) ? { state: 'unavailable' } : { state: 'error', message: message(err) }
  }
  const was = get(loadsAtom)[key]
  if (was !== undefined && JSON.stringify(was) === JSON.stringify(next)) return
  set(loadsAtom, (prev) => ({ ...prev, [key]: next }))
})

export const addThreadAtom = atom(
  null,
  async (get, set, args: { path: string; anchor: CommentAnchor; body: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return null
    const { thread } = await trpc.comments.add.mutate({ remote, ...args })
    await set(refreshThreadsAtom, args.path)
    return thread
  },
)

export const replyThreadAtom = atom(
  null,
  async (get, set, args: { path: string; thread: string; body: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await trpc.comments.reply.mutate({ remote, ...args })
    await set(refreshThreadsAtom, args.path)
  },
)

/** Resolve, or reopen with `resolved: false`. */
export const resolveThreadAtom = atom(
  null,
  async (get, set, args: { path: string; thread: string; resolved: boolean }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await trpc.comments.setResolved.mutate({ remote, ...args })
    await set(refreshThreadsAtom, args.path)
  },
)
