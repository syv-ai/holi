/**
 * Home when it names no document: the vault's library (docs/features/home.md),
 * after Notion's. The vault's name, a row of tabs (Recent, Notes, Tasks,
 * Activity) with search and New note at its end, and one plain table: what
 * it is, when it last changed, who changed it.
 *
 * **Git is the record of who and when** (`notes.fileCards`): the last commit
 * that touched each shown file, the mtime only before its first commit.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  CircleCheck,
  Clock,
  FileText,
  GitCommitHorizontal,
  Plus,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fileKind, isTaskFilePath } from '@holi/shared'
import type { FileCard } from '../../../../main/vault/file-cards'
import { pathLabel } from '@/composites/file-icons'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Icon,
  IconButton,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/primitives'
import { relativeTime } from '@/lib/relative-time'
import { trpc } from '@/lib/trpc'
import { pinsAtom, togglePinAtom } from '@/state/pins'
import { openPathAtom } from '@/state/surfaces'
import { runCommandAtom } from '@/state/commands'
import { openTaskCountAtom } from '@/state/tasks'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { ActivityFeed } from './ActivityFeed'

type Tab = 'recent' | 'notes' | 'tasks' | 'activity'

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'recent', label: 'Recent', icon: Clock },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'tasks', label: 'Tasks', icon: CircleCheck },
  { id: 'activity', label: 'Activity', icon: GitCommitHorizontal },
]

/** Rows a tab shows: the library is a glance, the tree and ⌘K are the index. */
const ROWS = 50

const hidden = (path: string) => path.split('/').some((seg) => seg.startsWith('.'))

export function LibraryView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const snapshot = useAtomValue(snapshotAtom)
  const openPath = useSetAtom(openPathAtom)
  const runCommand = useSetAtom(runCommandAtom)
  const pins = useAtomValue(pinsAtom)
  const togglePin = useSetAtom(togglePinAtom)
  const openTasks = useAtomValue(openTaskCountAtom)
  const noteCount = useMemo(
    () =>
      snapshot.docs.filter(
        (f) => !hidden(f.path) && fileKind(f.path) === 'markdown' && !isTaskFilePath(f.path),
      ).length,
    [snapshot.docs],
  )
  const [tab, setTab] = useState<Tab>('recent')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const files = useMemo(() => {
    const all = [...snapshot.docs, ...snapshot.files].filter((f) => !hidden(f.path))
    const inTab =
      tab === 'notes'
        ? all.filter((f) => fileKind(f.path) === 'markdown' && !isTaskFilePath(f.path))
        : tab === 'tasks'
          ? all.filter((f) => isTaskFilePath(f.path))
          : all
    return inTab
      .filter((f) => q === '' || pathLabel(f.path).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, ROWS)
  }, [snapshot.docs, snapshot.files, tab, q])

  // Who and when, refetched when a shown file changes.
  const key = files.map((f) => `${f.path}@${f.updatedAt}`).join('|')
  const [cards, setCards] = useState<Map<string, FileCard> | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(() => {
    if (remote === null || tab === 'activity') return
    setError(false)
    void trpc.notes.fileCards
      .query({ remote, paths: files.map((f) => f.path) })
      .then((list) => setCards(new Map(list.map((c) => [c.path, c]))))
      .catch(() => setError(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, key, tab])
  useEffect(load, [load])

  /** A new, untitled note at the vault's root, opened: the palette's own command. */
  const newNote = () => runCommand('note.new')

  const closeSearch = () => {
    setSearching(false)
    setQuery('')
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      {/* One left edge for the title, the first tab's icon, the header and the
          rows' icons: the tab list and the table hang their own insets out
          past it, so their fills reach beyond the text and their text does
          not. */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-8 pt-10 pb-14">
        {/* The vault in the display voice of the screens before it (sign-in's
            headline), with what it holds under it. The view's one entrance:
            it rises into place as Home opens. */}
        <header className="flex min-w-0 flex-col gap-1 motion-in-rise">
          <h1 className="truncate text-4xl leading-tight font-semibold tracking-[-0.03em]">
            {vault?.name ?? 'Vault'}
          </h1>
          <p className="truncate text-sm text-muted-foreground tabular-nums">
            {remote !== null && <span className="font-mono text-xs">{remote}</span>}
            {` · ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`}
            {` · ${openTasks} open ${openTasks === 1 ? 'task' : 'tasks'}`}
          </p>
        </header>

        <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)} className="gap-6">
          <div className="flex flex-wrap items-center gap-1">
            <TabsList variant="line" aria-label="Show" className="-ms-2.5">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  <Icon icon={t.icon} size="sm" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="ms-auto flex items-center gap-1">
              {tab !== 'activity' &&
                (searching ? (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      aria-label="Search the library"
                      placeholder="Search…"
                      value={query}
                      className="w-48"
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
                    />
                    <IconButton icon={X} label="Close search" onClick={closeSearch} />
                  </div>
                ) : (
                  <IconButton icon={Search} label="Search" onClick={() => setSearching(true)} />
                ))}
              <Button size="sm" className="ms-1" onClick={() => void newNote()}>
                <Icon icon={Plus} size="sm" />
                New note
              </Button>
            </div>
          </div>

          {/* One panel, whichever tab is chosen: the list below is the tab's. */}
          <TabsContent value={tab} className="flex flex-col gap-3">
            {tab === 'activity' ? (
              <ActivityFeed />
            ) : files.length === 0 ? (
              <div className="flex flex-col items-start gap-3 py-6 text-sm text-muted-foreground">
                {q !== ''
                  ? `Nothing named “${query.trim()}”.`
                  : tab === 'tasks'
                    ? 'No tasks yet.'
                    : 'Nothing here yet.'}
                {q !== '' ? (
                  <Button variant="outline" size="sm" onClick={closeSearch}>
                    Clear search
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void newNote()}>
                    New note
                  </Button>
                )}
              </div>
            ) : (
              <>
                {/* Who changed what is a second, git-backed lookup. Its failure
                    costs only the By column: the names and times are already
                    known, so the list stays. */}
                {error && (
                  <div
                    role="alert"
                    className="flex items-center gap-3 text-sm text-muted-foreground"
                  >
                    Couldn’t read who changed these files.
                    <Button variant="outline" size="sm" onClick={load}>
                      Retry
                    </Button>
                  </div>
                )}
                <div className="-mx-3">
                  <table className="w-full table-fixed border-separate border-spacing-0">
                    <thead>
                      <tr className="[&>th]:border-b [&>th]:border-divider">
                        <th
                          scope="col"
                          className="h-8 px-3 text-start text-xs font-normal text-muted-foreground"
                        >
                          Name
                        </th>
                        <th
                          scope="col"
                          className="h-8 w-40 px-3 text-start text-xs font-normal text-muted-foreground"
                        >
                          Edited
                        </th>
                        <th
                          scope="col"
                          className="h-8 w-36 px-3 text-start text-xs font-normal text-muted-foreground max-sm:hidden"
                        >
                          By
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => {
                        const card = cards?.get(f.path)
                        return (
                          <ContextMenu key={f.path}>
                            <ContextMenuTrigger asChild>
                              <tr className="motion-respond hover:bg-foreground/[0.04] [&>td]:border-b [&>td]:border-divider">
                                <td className="h-11">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="w-full min-w-0 justify-start text-start font-normal hover:bg-transparent dark:hover:bg-transparent"
                                    onClick={() => openPath(f.path, 'pinned')}
                                  >
                                    <Icon
                                      icon={isTaskFilePath(f.path) ? CircleCheck : FileText}
                                      size="sm"
                                      tone="muted"
                                    />
                                    <span className="truncate">{pathLabel(f.path)}</span>
                                  </Button>
                                </td>
                                <td className="px-3 text-nav text-muted-foreground tabular-nums">
                                  {relativeTime(card?.last?.date ?? f.updatedAt)}
                                </td>
                                <td className="truncate px-3 text-nav text-muted-foreground max-sm:hidden">
                                  {error && card === undefined ? (
                                    '—'
                                  ) : cards === null ? (
                                    <span
                                      role="status"
                                      aria-label="Loading"
                                      className="block h-3 w-20 rounded motion-shimmer"
                                    />
                                  ) : (
                                    (card?.last?.author ?? 'Not committed')
                                  )}
                                </td>
                              </tr>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-52">
                              <ContextMenuItem onSelect={() => openPath(f.path, 'pinned')}>
                                Open
                              </ContextMenuItem>
                              <ContextMenuItem onSelect={() => openPath(f.path, 'pane')}>
                                Open in new pane
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onSelect={() => togglePin(f.path)}>
                                {pins.includes(f.path) ? 'Unpin from sidebar' : 'Pin to sidebar'}
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() => void navigator.clipboard.writeText(f.path)}
                              >
                                Copy path
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
