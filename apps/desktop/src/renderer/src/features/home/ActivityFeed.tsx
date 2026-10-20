/**
 * What changed in the vault lately, Home's Activity tab (docs/features/home.md): the
 * newest commits, each as one line (who, what, when, after Linear's issue
 * activity) with the files it touched under it, any of which opens.
 *
 * **Git is the record.** Every save, yours, a teammate's pulled in, or the
 * agent's, lands as a commit, so this one list shows a note the agent wrote,
 * a task it closed or a file a teammate moved, without any of them reporting
 * it. Read from `history.activity` when the vault's files change; never kept.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { CircleCheck, FileText, GitCommitHorizontal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { isTaskFilePath } from '@holi/shared'
import { pathLabel } from '@/composites/file-icons'
import { Button, Icon } from '@/primitives'
import { relativeTime } from '@/lib/relative-time'
import { trpc } from '@/lib/trpc'
import { openPathAtom } from '@/state/surfaces'
import { snapshotAtom } from '@/state/vaults'

type Activity = Awaited<ReturnType<typeof trpc.history.activity.query>>

/** How many lines show before "Show more". */
const FIRST = 5

export function ActivityFeed(): React.JSX.Element {
  const snapshot = useAtomValue(snapshotAtom)
  const openPath = useSetAtom(openPathAtom)
  const [items, setItems] = useState<Activity | null>(null)
  const [error, setError] = useState(false)
  const [all, setAll] = useState(false)
  const present = new Set([...snapshot.docs, ...snapshot.files].map((f) => f.path))

  const load = useCallback(() => {
    setError(false)
    void trpc.history.activity
      .query()
      .then(setItems)
      .catch(() => setError(true))
  }, [])
  // Again whenever the files change: a save is a commit a moment later.
  useEffect(load, [load, snapshot])

  return (
    <section aria-label="Activity" className="flex flex-col">
      {error ? (
        <div className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
          Couldn’t read the vault’s history.
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      ) : items === null ? (
        <div role="status" aria-label="Loading activity" className="flex flex-col gap-2 py-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="block h-4 w-2/3 rounded motion-shimmer" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          No changes yet. Each save lands here as a commit.
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-divider">
          {(all ? items : items.slice(0, FIRST)).map(({ commit, files: touched, total }) => {
            // The vault's machinery (`.holi/`, `.claude/`) is not what anyone
            // came to see; it still counts in "+n more".
            const files = touched.filter((p) => !p.split('/').some((seg) => seg.startsWith('.')))
            return (
              <li key={commit.sha} className="flex gap-2.5 py-2">
                <span className="flex h-5 items-center">
                  <Icon icon={GitCommitHorizontal} size="sm" tone="muted" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {/* One sentence, the time inline after it (Linear's activity
                      line), so the date never drifts to the far edge. Never
                      clamped: a commit subject is short, and a cut one had no
                      way back to the rest. */}
                  <p className="min-w-0 text-nav text-pretty break-words text-muted-foreground">
                    <span className="font-medium text-foreground">{commit.author}</span>{' '}
                    {commit.subject}
                    <span className="ms-1.5 text-xs whitespace-nowrap tabular-nums">
                      · {relativeTime(commit.date)}
                    </span>
                  </p>
                  {files.length > 0 && (
                    <div className="-ms-2 flex flex-wrap items-center gap-0.5">
                      {files.map((path) =>
                        present.has(path) ? (
                          <Button
                            key={path}
                            variant="ghost"
                            size="xs"
                            className="font-normal text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                            onClick={() => openPath(path, 'pinned')}
                          >
                            <Icon icon={isTaskFilePath(path) ? CircleCheck : FileText} size="sm" />
                            {pathLabel(path)}
                          </Button>
                        ) : (
                          // Gone since (deleted or moved): named, not a dead button.
                          <span
                            key={path}
                            className="inline-flex h-6 items-center gap-1 px-2 text-xs text-muted-foreground"
                          >
                            <Icon icon={FileText} size="sm" />
                            {pathLabel(path)} (deleted)
                          </span>
                        ),
                      )}
                      {total > files.length && (
                        <span className="px-2 text-xs text-muted-foreground">
                          +{total - files.length} more
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {items !== null && items.length > FIRST && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 -ms-2 self-start font-normal text-muted-foreground hover:bg-foreground/[0.04]"
          onClick={() => setAll((a) => !a)}
        >
          {all ? 'Show less' : `Show ${items.length - FIRST} more`}
        </Button>
      )}
    </section>
  )
}
