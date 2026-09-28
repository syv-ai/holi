/**
 * The vault's history, as a tab.
 *
 * A tab rather than a modal, so what a commit changed can sit open beside the
 * note it changed.
 *
 * **The file tree's system, three levels deep** (`composites/tree.tsx`): days
 * are the headings, a day's commits hang from it, and the picked commit's
 * changed files hang from the commit. Picking is expansion, as in the settings
 * rail: the picked commit opens to its files, its day wears the tree's bar,
 * and the way down to what the right side shows is lit.
 *
 * **Commit-first, and then every file at once.** A picked commit shows one
 * collapsible per changed file with its diff inside, rather than a second list
 * to click through: a commit is a single act and this reads it as one. A
 * file's row narrows that to its one diff; the commit's row widens it again.
 *
 * A floating dock at the foot searches the log, as the board's does its cards.
 *
 * The per-note history side panel (`HistoryPanel`) is the file-first surface.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Icon,
  IconButton,
  Input,
  MorphingMenu,
  Tooltip,
  type MorphingMenuItem,
} from '@/primitives'
import {
  Churn,
  DiffView,
  PanelHeader,
  TREE_LABEL,
  TREE_NESTED_HANG,
  TREE_NESTED_ROW,
  TREE_ROOT_HANG,
  TREE_ROOT_ROW,
  TREE_ROW,
  TREE_ROW_RESET,
  TreeBar,
  TreeBranch,
  TreeDisclose,
  treeLead,
  treeNestedTone,
  treeRootTone,
} from '@/composites'
import { pathGlyph, pathLabel } from '@/composites/file-icons'
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
  const tree = useRef<HTMLElement>(null)
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
  const selectedDay = selected ? dayKey(new Date(selected.date)) : null

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

  // The commit on the remote: GitHub is the vault's host (D60).
  const openCommit = (sha: string) => {
    if (remote !== null) void window.holi.openExternal(`https://github.com/${remote}/commit/${sha}`)
  }

  const commitRows = (dayCommits: Version[]): ReactNode => {
    const litIndex = dayCommits.findIndex((c) => c.sha === selectedSha)
    return (
      <div className="relative py-1">
        {dayCommits.map((c, i) => {
          const isSelected = c.sha === selectedSha
          return (
            <TreeBranch
              key={c.sha}
              last={i === dayCommits.length - 1}
              lit={i === litIndex}
              litThrough={litIndex > i}
            >
              <Button
                variant="ghost"
                role="treeitem"
                aria-expanded={isSelected}
                aria-selected={isSelected && file === null}
                onClick={() => pick(c)}
                className={cn(
                  TREE_ROW_RESET,
                  TREE_NESTED_ROW,
                  treeNestedTone(isSelected && file === null, isSelected),
                )}
                style={{ height: TREE_ROW }}
              >
                <span className={treeLead(isSelected)}>
                  <Icon
                    icon={ChevronRight}
                    size="sm"
                    className={cn('motion-respond', isSelected && 'rotate-90')}
                  />
                </span>
                <span className={cn(TREE_LABEL, 'flex-1 text-left')}>
                  {c.subject || '(no message)'}
                </span>
                <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                  {time(c.date)}
                </span>
              </Button>
              <div style={{ marginLeft: TREE_NESTED_HANG }}>
                <TreeDisclose open={isSelected && files.length > 0}>
                  {isSelected && fileRows()}
                </TreeDisclose>
              </div>
            </TreeBranch>
          )
        })}
      </div>
    )
  }

  const fileRows = (): ReactNode => {
    const litIndex = file === null ? -1 : files.indexOf(file)
    return (
      <div className="relative py-1">
        {files.map((path, i) => {
          const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
          return (
            <TreeBranch
              key={path}
              last={i === files.length - 1}
              lit={i === litIndex}
              litThrough={litIndex > i}
            >
              <Button
                variant="ghost"
                role="treeitem"
                aria-selected={file === path}
                onClick={() => setFile(path)}
                className={cn(
                  TREE_ROW_RESET,
                  TREE_NESTED_ROW,
                  treeNestedTone(file === path, file === path),
                )}
                style={{ height: TREE_ROW }}
              >
                <span className={treeLead(file === path)}>{pathGlyph(path)}</span>
                <span className={TREE_LABEL}>{pathLabel(path)}</span>
                {dir !== '' && (
                  <span className={cn(TREE_LABEL, 'text-[11px] text-muted-foreground')}>{dir}</span>
                )}
              </Button>
            </TreeBranch>
          )
        })}
      </div>
    )
  }

  const dock: MorphingMenuItem[] = [
    {
      id: 'search',
      label: search ? `Search: ${search}` : 'Search commits',
      icon: Search,
      pressed: search !== '' || undefined,
      panel: (close) => (
        <div data-morph-row="" className="flex w-80 items-center gap-2 px-2 py-1">
          <Icon icon={Search} tone="muted" />
          <Input
            variant="bare"
            value={search}
            placeholder="Search messages and authors"
            aria-label="Search commits"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') close()
            }}
            className="text-sm"
          />
          {search && <IconButton icon={X} label="Clear search" onClick={() => setSearch('')} />}
        </div>
      ),
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <span className="font-medium text-foreground">History</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{remote ?? ''}</span>
      </PanelHeader>

      <div data-morph-stage="" className="relative flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-y-auto pb-20 pt-3">
          {commits.length === 0 ? (
            <p className="px-6 text-xs text-muted-foreground">No commits yet.</p>
          ) : days.length === 0 ? (
            <p className="px-6 text-xs text-muted-foreground">No commit matches.</p>
          ) : (
            <nav ref={tree} role="tree" aria-label="Commits" className="relative flex flex-col">
              <TreeBar
                container={tree}
                selector={
                  selectedDay ? `:scope > div > [data-day="${CSS.escape(selectedDay)}"]` : null
                }
                deps={[days, closedDays, files]}
              />
              {days.map((day) => {
                // A search opens every day it matched in, so a hit is never
                // hidden behind a closed heading.
                const open = query !== '' || !closedDays.has(day.key)
                return (
                  <div key={day.key}>
                    <Button
                      variant="ghost"
                      role="treeitem"
                      data-day={day.key}
                      aria-expanded={open}
                      onClick={() => toggleDay(day.key)}
                      className={cn(
                        TREE_ROW_RESET,
                        TREE_ROOT_ROW,
                        treeRootTone(day.key === selectedDay),
                      )}
                    >
                      <span className={treeLead(day.key === selectedDay)}>
                        <Icon
                          icon={ChevronRight}
                          size="sm"
                          className={cn('motion-respond', open && 'rotate-90')}
                        />
                      </span>
                      <span className={TREE_LABEL}>{dayLabel(day.key, now)}</span>
                    </Button>
                    <div style={{ marginLeft: TREE_ROOT_HANG }}>
                      <TreeDisclose open={open}>{commitRows(day.commits)}</TreeDisclose>
                    </div>
                  </div>
                )
              })}
            </nav>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <p className="p-6 text-xs text-muted-foreground">
              Pick a commit to see everything it changed.
            </p>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-3 px-6 pb-20 pt-5">
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
                      className="h-auto px-1 py-0 font-mono text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-brand"
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

        {/* The board's floating dock, centred at the foot of the view. */}
        <div className="pointer-events-none absolute bottom-4 left-0 flex w-full justify-center">
          <div className="pointer-events-auto w-40">
            <MorphingMenu label="History" anchor="bottom-center" surface="float" items={dock} />
          </div>
        </div>
      </div>
    </div>
  )
}
