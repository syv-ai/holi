/**
 * The vault's history, as a tab.
 *
 * A tab rather than a modal, so what a commit changed can sit open beside the
 * note it changed.
 *
 * **The app's one tree, three levels deep** (`primitives/Tree.tsx`): days
 * are the top level, a day's commits sit under it, and the picked commit's
 * changed files under the commit. Picking is expansion, as in the settings
 * rail: the picked commit opens to its files, and what the right side shows
 * wears the sidebar's current-row fill.
 *
 * **Commit-first, and then every file at once.** A picked commit shows one
 * collapsible per changed file with its diff inside, rather than a second list
 * to click through: a commit is a single act and this reads it as one. A
 * file's row narrows that to its one diff; the commit's row widens it again.
 *
 * A search field in the header narrows the log by message and author.
 *
 * The per-note history side panel (`HistoryPanel`) is the file-first surface.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core'
import { useTree } from '@headless-tree/react'
import {
  Button,
  Icon,
  IconButton,
  Input,
  Tooltip,
  Tree,
  TreeItem,
  TreeItemLabel,
} from '@/primitives'
import { Churn, DiffView, PanelHeader } from '@/composites'
import { fileIconFor, pathGlyph, pathLabel } from '@/composites/file-icons'
import { cn } from '@/lib/cn'
import {
  commitDiffsAtom,
  commitFilesAtom,
  loadCommitDiffAtom,
  loadVaultLogAtom,
  resetVaultLogAtom,
  selectCommitAtom,
  selectedCommitShaAtom,
  vaultCommitsAtom,
  type Version,
} from '@/state/history'
import { activeRemoteAtom } from '@/state/vaults'

/** `date` is an ISO string, not a Date: no superjson transformer on the ipcLink. */
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** A local calendar day, as a sortable key. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A day's heading: Today, Yesterday, else the date. */
function dayLabel(key: string, now: Date): string {
  if (key === dayKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === dayKey(yesterday)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y!, m! - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(y !== now.getFullYear() && { year: 'numeric' }),
  })
}

const ROOT = '__root__'

/** One row of the history tree. */
type HistoryItem = { name: string; children: string[] } & (
  | { kind: 'root' }
  | { kind: 'day'; key: string }
  | { kind: 'commit'; commit: Version }
  | { kind: 'file'; path: string }
)

/** The log in days, newest first, as git lists it. */
function byDay(commits: Version[]): { key: string; commits: Version[] }[] {
  const days: { key: string; commits: Version[] }[] = []
  for (const c of commits) {
    const key = dayKey(new Date(c.date))
    const last = days[days.length - 1]
    if (last?.key === key) last.commits.push(c)
    else days.push({ key, commits: [c] })
  }
  return days
}

/**
 * One changed file: a header that collapses, and the diff under it.
 *
 * It asks for its own diff when it first opens, so a commit's files fetch in
 * parallel, and re-opening a collapsed file costs nothing because the answer
 * is kept per commit rather than per view.
 */
function FileEntry({ path, sha }: { path: string; sha: string }): React.JSX.Element {
  // Expanded by default: a commit is usually small, and the surface exists to be
  // read rather than navigated.
  const [open, setOpen] = useState(true)
  const diffs = useAtomValue(commitDiffsAtom)
  const loadDiff = useSetAtom(loadCommitDiffAtom)
  const diff = diffs[path]

  useEffect(() => {
    if (open && diff === undefined) void loadDiff(path)
  }, [open, diff, loadDiff, path, sha])

  return (
    <section className="overflow-hidden rounded-lg bg-card">
      <Button
        variant="ghost"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-2 text-left text-xs font-normal hover:bg-accent/50"
      >
        <Icon
          icon={ChevronRight}
          size="sm"
          tone="muted"
          className={cn('motion-respond', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
      </Button>
      {open && (
        <div className="max-h-[60vh] overflow-auto">
          {diff === undefined ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">Loading…</p>
          ) : diff.before === '' && diff.after === '' ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground italic">
              This commit did not change this file&rsquo;s contents.
            </p>
          ) : (
            <DiffView before={diff.before} after={diff.after} />
          )}
        </div>
      )}
    </section>
  )
}

export function HistoryView(): React.JSX.Element {
  const commits = useAtomValue(vaultCommitsAtom)
  const selectedSha = useAtomValue(selectedCommitShaAtom)
  const files = useAtomValue(commitFilesAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const load = useSetAtom(loadVaultLogAtom)
  const selectCommit = useSetAtom(selectCommitAtom)
  const reset = useSetAtom(resetVaultLogAtom)
  /** The file the right side narrows to, or null for the whole commit. */
  const [file, setFile] = useState<string | null>(null)
  /** Days folded away. Every day starts open: the log is there to be read. */
  const [closedDays, setClosedDays] = useState<ReadonlySet<string>>(new Set())
  const [search, setSearch] = useState('')

  // Per vault: a switch must not leave the last one's commits on screen, and the
  // tab outlives the switch.
  useEffect(() => {
    reset()
    setFile(null)
    setClosedDays(new Set())
    void load()
  }, [remote, load, reset])

  const query = search.trim().toLowerCase()
  const days = useMemo(
    () =>
      byDay(
        query === ''
          ? commits
          : commits.filter((c) => `${c.subject}\n${c.author}`.toLowerCase().includes(query)),
      ),
    [commits, query],
  )
  const now = new Date()
  const selected = commits.find((c) => c.sha === selectedSha) ?? null

  const toggleDay = (key: string) =>
    setClosedDays((was) => {
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const pick = (c: Version) => {
    setFile(null)
    if (c.sha !== selectedSha) void selectCommit(c.sha)
  }

  // The commit on the remote: GitHub is the vault's host.
  const openCommit = (sha: string) => {
    if (remote !== null) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  // The log as the tree's data: days, their commits, and the picked commit's
  // files. Ids are prefixed by level, so a day, a sha and a path never meet.
  const items = useMemo(() => {
    const out: Record<string, HistoryItem> = {
      [ROOT]: { kind: 'root', name: '', children: days.map((d) => `d:${d.key}`) },
    }
    for (const day of days) {
      out[`d:${day.key}`] = {
        kind: 'day',
        name: dayLabel(day.key, now),
        key: day.key,
        children: day.commits.map((c) => `c:${c.sha}`),
      }
      for (const c of day.commits)
        out[`c:${c.sha}`] = {
          kind: 'commit',
          name: c.subject || '(no message)',
          commit: c,
          children: c.sha === selectedSha ? files.map((p) => `f:${p}`) : [],
        }
    }
    for (const path of files)
      out[`f:${path}`] = { kind: 'file', name: pathLabel(path), path, children: [] }
    return out
    // `now` moves every render; the day labels follow the log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, files, selectedSha])
  const expandedItems = useMemo(
    () => [
      // A search opens every day it matched in, so a hit is never hidden
      // behind a closed heading.
      ...days.filter((d) => query !== '' || !closedDays.has(d.key)).map((d) => `d:${d.key}`),
      ...(selectedSha !== null && files.length > 0 ? [`c:${selectedSha}`] : []),
    ],
    [days, query, closedDays, selectedSha, files],
  )
  const tree = useTree<HistoryItem>({
    rootItemId: ROOT,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind !== 'file',
    dataLoader: {
      getItem: (id) => items[id] ?? { kind: 'root', name: '', children: [] },
      getChildren: (id) => items[id]?.children ?? [],
    },
    state: { expandedItems },
    // The keys' way to open and close: a day folds, and opening a commit picks it.
    setExpandedItems: (next) => {
      const ids = typeof next === 'function' ? next(expandedItems) : next
      for (const id of [...ids, ...expandedItems]) {
        if (ids.includes(id) === expandedItems.includes(id)) continue
        const item = items[id]
        if (item?.kind === 'day') toggleDay(item.key)
        else if (item?.kind === 'commit' && ids.includes(id)) pick(item.commit)
      }
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  })

  /** A row's click: a day folds, a commit is picked, a file narrows the diff. */
  const activate = (item: HistoryItem) => {
    if (item.kind === 'day') toggleDay(item.key)
    else if (item.kind === 'commit') pick(item.commit)
    else if (item.kind === 'file') setFile(item.path)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <span className="font-medium text-foreground">History</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{remote ?? ''}</span>
        <div className="flex w-56 shrink-0 items-center gap-1.5">
          <Icon icon={Search} size="sm" tone="muted" />
          <Input
            variant="bare"
            value={search}
            placeholder="Search messages and authors"
            aria-label="Search commits"
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && <IconButton icon={X} label="Clear search" onClick={() => setSearch('')} />}
        </div>
      </PanelHeader>

      <div className="relative flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-y-auto pt-3 pb-4">
          {commits.length === 0 ? (
            <p className="px-6 text-xs text-muted-foreground">No commits yet.</p>
          ) : days.length === 0 ? (
            <p className="px-6 text-xs text-muted-foreground">No commit matches.</p>
          ) : (
            <Tree tree={tree} indent={20} aria-label="Commits" className="px-2">
              {tree.getItems().map((item) => {
                const data = item.getItemData()
                const current =
                  data.kind === 'commit'
                    ? data.commit.sha === selectedSha && file === null
                    : data.kind === 'file' && data.path === file
                const dir =
                  data.kind === 'file' && data.path.includes('/')
                    ? data.path.slice(0, data.path.lastIndexOf('/'))
                    : ''
                return (
                  <TreeItem
                    key={item.getId()}
                    item={item}
                    data-day={data.kind === 'day' ? data.key : undefined}
                    aria-selected={data.kind === 'day' ? undefined : current}
                    aria-expanded={
                      data.kind === 'commit'
                        ? data.commit.sha === selectedSha
                        : data.kind === 'file'
                          ? undefined
                          : item.isExpanded()
                    }
                    onClick={() => {
                      item.setFocused()
                      activate(data)
                    }}
                    className="w-full"
                  >
                    <TreeItemLabel
                      className={cn(
                        'min-w-0 text-muted-foreground hover:text-foreground',
                        data.kind === 'day' && 'text-foreground',
                        current && 'bg-foreground/[0.06] text-foreground',
                      )}
                    >
                      {data.kind === 'file' && (
                        <span className="flex w-3.5 shrink-0 justify-center">
                          {pathGlyph(data.path) ?? fileIconFor(data.path)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{data.name}</span>
                      {data.kind === 'commit' && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {time(data.commit.date)}
                        </span>
                      )}
                      {dir !== '' && (
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {dir}
                        </span>
                      )}
                    </TreeItemLabel>
                  </TreeItem>
                )
              })}
            </Tree>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <p className="p-6 text-xs text-muted-foreground">
              Pick a commit to see everything it changed.
            </p>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-3 px-6 pt-5 pb-6">
              <header className="flex flex-col gap-1">
                <h2 className="text-base font-medium text-foreground">
                  {selected.subject || '(no message)'}
                </h2>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{selected.author}</span>
                  <span>{when(selected.date)}</span>
                  <Churn added={selected.added} removed={selected.removed} />
                  <Tooltip content={`open commit ${selected.sha.slice(0, 7)} on GitHub`}>
                    <Button
                      variant="ghost"
                      onClick={() => openCommit(selected.sha)}
                      className="h-auto px-1 py-0 font-mono text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-brand"
                    >
                      {selected.sha.slice(0, 7)}
                    </Button>
                  </Tooltip>
                </p>
              </header>
              {files.length === 0 ? (
                <p className="text-xs text-muted-foreground">This commit changed no files.</p>
              ) : (
                (file === null ? files : [file]).map((path) => (
                  <FileEntry key={path} path={path} sha={selected.sha} />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
