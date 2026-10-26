/**
 * The Agents mode's session cards (docs/features/agent-sessions.md, The
 * Agents view), drawn twice: the sidebar's **Sessions**, the conversations
 * and runs that are open, each with its ×; and **History**, every one of
 * them by day under a "Search conversations…" field with a filter menu
 * (`./session-filters`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { HistoryIcon, MessageSquarePlusIcon } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, useNow, useTabDrag } from '@/plugin-api'
import { agentsViewAtom } from '../state/agents-view'
import { agentSessionsAtom } from '../state/sessions'
import {
  closeSessionRowAtom,
  groupRows,
  keyOwner,
  newSessionAtom,
  NO_FILTER,
  openSessionRowAtom,
  openSessionRowsAtom,
  reloadSessionsAtom,
  rowAbilitiesAtom,
  rowMatches,
  sessionFilterAtom,
  sessionQueryAtom,
  sessionRowsAtom,
  sessionsStatusAtom,
  type SessionGroup,
  type SessionRow,
} from '../state/session-list'
import { NewSessionButton } from './new-session-button'
import { SessionCard, tabOf } from './session-card'
import { CardWithMenu, DeleteDialog } from './session-card-menu'

function LoadingCards(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading conversations" className="flex flex-col gap-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 px-2 py-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}

/** A run of cards under a heading, or none: the sidebar's open ones are one
 *  run without. */
type CardGroup = Pick<SessionGroup, 'rows'> & { id: string; label?: string }

/**
 * Cards in groups, with arrow keys between them, their menus, Rename in place
 * and Delete asked first. An open card's menu offers Close, and with `closable`
 * it shows its × too.
 */
function SessionCards({
  groups,
  now,
  openKeys,
  closable,
}: {
  groups: readonly CardGroup[]
  now: number
  openKeys: ReadonlySet<string>
  closable: boolean
}): React.JSX.Element {
  const open = useSetAtom(openSessionRowAtom)
  const close = useSetAtom(closeSessionRowAtom)
  const listRef = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionRow | null>(null)
  const abilities = useAtomValue(rowAbilitiesAtom)
  const live = useAtomValue(agentSessionsAtom)
  const tabDrag = useTabDrag()

  const rows = groups.flatMap((g) => g.rows)
  const order = rows.map((r) => r.item.key)
  // One card in the tab order: the focused one, else the open one, else the first.
  const tabKey =
    (focusKey !== null && order.includes(focusKey) && focusKey) ||
    rows.find((r) => r.current)?.item.key ||
    order[0]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const cards = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-session-card]') ?? [],
    )
    if (cards.length === 0) return
    e.preventDefault()
    const at = cards.findIndex((c) => c === document.activeElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? cards.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(cards.length - 1, at + 1)
            : Math.max(0, at - 1)
    cards[next]?.focus()
  }

  return (
    <>
      <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-3" data-session-list="">
        {groups.map((group) => (
          <div
            key={group.id}
            role={group.label === undefined ? undefined : 'group'}
            aria-label={group.label}
            className="flex flex-col gap-0.5"
          >
            {group.label !== undefined && (
              <div
                aria-hidden="true"
                className={cn(
                  'px-2 pt-1 pb-0.5 text-xs text-muted-foreground/70',
                  group.id === 'needs-you' && 'font-medium text-foreground',
                )}
              >
                {group.label}
              </div>
            )}
            {group.rows.map((row) => {
              const isOpen = openKeys.has(row.item.key)
              const withClose = closable && isOpen
              return (
                <CardWithMenu
                  key={row.item.key}
                  row={row}
                  renaming={renaming === row.item.key}
                  onRename={() => setRenaming(row.item.key)}
                  onRenamed={() => {
                    setRenaming(null)
                    // Back to the card, as the field found it.
                    requestAnimationFrame(() =>
                      listRef.current
                        ?.querySelector<HTMLButtonElement>(
                          `[data-session-card="${CSS.escape(row.item.key)}"]`,
                        )
                        ?.focus(),
                    )
                  }}
                  onDelete={() => setDeleting(row)}
                  onClose={isOpen ? () => void close(row.item) : undefined}
                  closable={withClose}
                >
                  <SessionCard
                    row={row}
                    now={now}
                    focusable={row.item.key === tabKey}
                    onFocus={() => setFocusKey(row.item.key)}
                    onOpen={() => void open(row.item)}
                    // A row that can be a tab drags as one, onto the content
                    // or the strip.
                    {...tabDrag(tabOf(row.item, live))}
                    onKeyDown={(e) => {
                      // F2 renames, as it does in the documents tree.
                      if (e.key === 'F2' && abilities.get(keyOwner(row.item.key))?.rename) {
                        e.preventDefault()
                        setRenaming(row.item.key)
                      }
                    }}
                    // Room for the buttons the hover shows: ⋯, and × on an
                    // open card.
                    className={
                      withClose
                        ? 'group-hover/card:pe-16 group-focus-within/card:pe-16'
                        : 'group-hover/card:pe-9 group-focus-within/card:pe-9'
                    }
                  />
                </CardWithMenu>
              )
            })}
          </div>
        ))}
      </div>
      <DeleteDialog row={deleting} onClose={() => setDeleting(null)} />
    </>
  )
}

/** The keys of the rows open in the Sessions list. */
function useOpenKeys(): ReadonlySet<string> {
  const rows = useAtomValue(openSessionRowsAtom)
  return useMemo(() => new Set(rows.map((r) => r.item.key)), [rows])
}

/** The sidebar's Sessions: the open ones, what needs you first, each with
 *  its ×. Closed ones are in History. */
export function SessionList(): React.JSX.Element {
  const rows = useAtomValue(openSessionRowsAtom)
  const all = useAtomValue(sessionRowsAtom)
  const status = useAtomValue(sessionsStatusAtom)
  const create = useSetAtom(newSessionAtom)
  const reload = useSetAtom(reloadSessionsAtom)
  const setView = useSetAtom(agentsViewAtom)
  const openKeys = useOpenKeys()
  const now = useNow()

  return (
    <section aria-label="Sessions" className="flex flex-col gap-2">
      {/* The Holis section's header: the label over the rows' icons, its +
          in line with Holis' own. */}
      <div className="flex items-center justify-between gap-2 pe-1">
        <h3 className="flex items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground select-none">
          Sessions
          {rows.length > 0 && <span className="tabular-nums">{rows.length}</span>}
        </h3>
        <NewSessionButton />
      </div>

      {status === 'error' ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"
        >
          Could not load the conversations.
          <Button size="xs" variant="outline" onClick={() => reload()}>
            Retry
          </Button>
        </div>
      ) : status === 'loading' && all.length === 0 ? (
        <LoadingCards />
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-sm">No active sessions</EmptyTitle>
            <EmptyDescription className="text-xs">
              Start one and it works in this vault while you write. Closed ones are in History.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button variant="outline" size="sm" onClick={() => void create()}>
              <MessageSquarePlusIcon aria-hidden="true" />
              New session
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setView({ kind: 'history' })}>
              <HistoryIcon aria-hidden="true" />
              History
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <SessionCards groups={[{ id: 'open', rows }]} now={now} openKeys={openKeys} closable />
      )}
    </section>
  )
}

/** History: every conversation and run, open or closed, by day, narrowed by
 *  the search and the filter (`SessionSearch`). */
export function SessionHistory(): React.JSX.Element {
  const rows = useAtomValue(sessionRowsAtom)
  const status = useAtomValue(sessionsStatusAtom)
  const query = useAtomValue(sessionQueryAtom)
  const filter = useAtomValue(sessionFilterAtom)
  const create = useSetAtom(newSessionAtom)
  const reload = useSetAtom(reloadSessionsAtom)
  const setQuery = useSetAtom(sessionQueryAtom)
  const setFilter = useSetAtom(sessionFilterAtom)
  const openKeys = useOpenKeys()
  const now = useNow()

  const visible = useMemo(
    () => rows.filter((r) => rowMatches(r, query, filter)),
    [rows, query, filter],
  )
  const groups = useMemo(() => groupRows(visible, now), [visible, now])
  const listed = rows.some((r) => r.item.archived !== true || filter.archived)

  return (
    <section aria-label="History" className="flex flex-col gap-4">
      {status === 'error' ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 text-sm text-muted-foreground"
        >
          Could not load the conversations.
          <Button size="xs" variant="outline" onClick={() => reload()}>
            Retry
          </Button>
        </div>
      ) : status === 'loading' && rows.length === 0 ? (
        <LoadingCards />
      ) : !listed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-sm">No conversations yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Start one and it works in this vault while you write. Holis and automations list their
              runs here too.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => void create()}>
              <MessageSquarePlusIcon aria-hidden="true" />
              New session
            </Button>
          </EmptyContent>
        </Empty>
      ) : visible.length === 0 ? (
        <div className="flex items-center justify-between gap-2 px-2 text-sm text-muted-foreground">
          No conversations match.
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setQuery('')
              setFilter(NO_FILTER)
            }}
          >
            Clear
          </Button>
        </div>
      ) : (
        <SessionCards groups={groups} now={now} openKeys={openKeys} closable={false} />
      )}
    </section>
  )
}
