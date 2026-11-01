/**
 * What the agents remember (docs/features/agent-memory.md): every memory in
 * `.holi/memory/`, shared and personal, grouped by type as the index groups
 * them. A row opens its file, where it can be read and corrected.
 *
 * Read from the files rather than from `index.md`, which lists shared
 * memories only and is rewritten only on a commit that touches memory.
 */
import { isExpiredMemory, isLocalOnlyPath, isMemoryPath, readMemoryEntry } from '@holi/shared'
import type { MemoryEntry } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Brain, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { activeRemoteAtom, openDocumentAtom, snapshotAtom, trpc } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { IconStackEmpty } from '@/components/ui/icon-stack-empty'
import { Skeleton } from '@/components/ui/skeleton'
import { newSessionAtom } from '../state/session-list'

type Memory = MemoryEntry & { personal: boolean; expired: boolean }

type Read =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; memories: Memory[] }

function Row({ memory }: { memory: Memory }): React.JSX.Element {
  const open = useSetAtom(openDocumentAtom)
  const meta = [
    memory.personal ? 'personal' : null,
    memory.expires === null ? null : `${memory.expired ? 'expired' : 'expires'} ${memory.expires}`,
  ].filter(Boolean)
  return (
    <li data-memory={memory.path}>
      <Button
        variant="ghost"
        size="row"
        className="w-full min-w-0"
        onClick={() => open(memory.path)}
      >
        <span className="flex w-full min-w-0 flex-col gap-1 py-1">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {memory.title}
            </span>
            {meta.length > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground">{meta.join(' · ')}</span>
            )}
          </span>
          {memory.description !== '' && (
            <span className="whitespace-normal text-sm text-muted-foreground">
              {memory.description}
            </span>
          )}
        </span>
      </Button>
    </li>
  )
}

export function MemoryList(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const create = useSetAtom(newSessionAtom)
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // Read again when a memory file is added, removed or changed, and only then.
  const files = useMemo(
    () => (snapshot?.docs ?? []).filter((doc) => isMemoryPath(doc.path)),
    [snapshot],
  )
  const stamp = files.map((doc) => `${doc.path}@${doc.updatedAt}`).join('\n')

  useEffect(() => {
    if (remote === null) return
    let live = true
    const now = new Date()
    // One file that will not read (a personal memory the expiry sweep just
    // deleted, which the watcher does not report) drops its row, not the list.
    void Promise.allSettled(
      files.map(async ({ path }): Promise<Memory> => {
        const text = await trpc.notes.read.query({ remote, path })
        return {
          ...readMemoryEntry(path, text),
          personal: isLocalOnlyPath(path),
          expired: isExpiredMemory(path, text, now),
        }
      }),
    ).then((results) => {
      if (!live) return
      const memories = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const failed = results.find((r) => r.status === 'rejected')
      if (memories.length === 0 && failed !== undefined) {
        const err: unknown = failed.reason
        setRead({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      } else setRead({ status: 'ready', memories })
    })
    return () => {
      live = false
    }
    // `stamp` stands for `files`: a new snapshot with the same memories reads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, stamp, attempt])

  if (read.status === 'loading') {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Reading memories">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (read.status === 'error') {
    return (
      <IconStackEmpty
        icon={Brain}
        title="Couldn't read the memories"
        description={read.message}
        role="alert"
        action={{ label: 'Retry', onClick: () => setAttempt((n) => n + 1) }}
      />
    )
  }
  if (read.memories.length === 0) {
    return (
      <IconStackEmpty
        icon={Brain}
        title="Nothing remembered yet"
        description="When an agent learns something worth keeping (a convention, a person, how this vault works), it writes one memory per fact in .holi/memory/. They show here."
        action={{ label: 'New session', icon: SquarePen, onClick: () => void create() }}
      />
    )
  }

  const byType = new Map<string, Memory[]>()
  for (const memory of read.memories)
    byType.set(memory.type, [...(byType.get(memory.type) ?? []), memory])
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b))

  return (
    <div className="flex flex-col gap-6">
      {types.map((type) => (
        <section key={type} aria-label={type} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            {/* Sentence case, as the Inbox's headings: types are written lowercase. */}
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </h2>
          <ul className="flex flex-col gap-1">
            {(byType.get(type) ?? [])
              .sort((a, b) => a.title.localeCompare(b.title))
              .map((memory) => (
                <Row key={memory.path} memory={memory} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
