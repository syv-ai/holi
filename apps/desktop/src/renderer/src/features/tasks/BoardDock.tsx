/**
 * The board's controls: one dock floating at its foot (docs/features/tasks.md),
 * the nav menu's morph (`MorphingMenu`, `bottom-center`). At rest four icons;
 * each grows the dock into what it does.
 *
 * **Still three narrowing controls, deliberately:** search, tags, hide done.
 * `overdue` and `p1`–`p3` are labels (D41), so they sit in the tag list beside
 * real tags and "the overdue p1s" is an ordinary tag query. The fourth icon is
 * quick add, which is not a filter.
 */
import { useAtom, useAtomValue } from 'jotai'
import { Eye, EyeOff, Plus, Search, Tag, X } from 'lucide-react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  Icon,
  IconButton,
  Input,
  MorphRow,
  MorphingMenu,
  type MorphingMenuHandle,
  type MorphingMenuItem,
} from '@/primitives'
import { nowAtom } from '@/state/clock'
import { availableLabels, filterAtom, quickAddAtom, tasksAtom } from '@/state/tasks'
import { QuickAdd } from './QuickAdd'

const newTask: MorphingMenuItem = {
  id: 'new',
  label: 'New task',
  icon: Plus,
  panel: () => <QuickAdd flight />,
}

export function BoardDock(): React.JSX.Element {
  const [filter, setFilter] = useAtom(filterAtom)
  const [quickAdd, setQuickAdd] = useAtom(quickAddAtom)
  const tasks = useAtomValue(tasksAtom)
  const now = useAtomValue(nowAtom)
  const labels = availableLabels(tasks.values(), now)
  const menu = useRef<MorphingMenuHandle>(null)

  // ⌘T on the board grows the dock into quick add, and the request is done.
  useEffect(() => {
    if (quickAdd?.where !== 'board') return
    menu.current?.openPanel('new')
    setQuickAdd(null)
  }, [quickAdd, setQuickAdd])

  const searchPanel = (close: () => void): ReactNode => (
    <div data-morph-row="" className="flex w-80 items-center gap-2 px-2 py-1">
      <Icon icon={Search} tone="muted" />
      <Input
        variant="bare"
        value={filter.search}
        placeholder="Search tasks"
        aria-label="Search tasks"
        data-filter-search
        onChange={(event) => setFilter((f) => ({ ...f, search: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') close()
        }}
        className="text-sm"
      />
      {filter.search && (
        <IconButton
          icon={X}
          label="Clear search"
          onClick={() => setFilter((f) => ({ ...f, search: '' }))}
        />
      )}
    </div>
  )

  const tagsPanel = (): ReactNode => (
    <div className="w-60">
      {labels.length === 0 && (
        <p data-morph-row="" className="px-2.5 py-1.5 text-sm text-muted-foreground">
          No tags yet
        </p>
      )}
      {labels.map((tag) => {
        const on = filter.tags.includes(tag)
        return (
          <MorphRow
            key={tag}
            label={tag}
            on={on}
            data-filter-tag={tag}
            onClick={() =>
              setFilter((f) => ({
                ...f,
                tags: on ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
              }))
            }
          />
        )
      })}
    </div>
  )

  const items = useMemo<MorphingMenuItem[]>(
    () => [
      {
        id: 'search',
        label: filter.search ? `Search: ${filter.search}` : 'Search',
        icon: Search,
        pressed: filter.search !== '' || undefined,
        panel: searchPanel,
      },
      {
        id: 'tags',
        label: filter.tags.length ? `Tags: ${filter.tags.join(', ')}` : 'Tags',
        icon: Tag,
        pressed: filter.tags.length > 0 || undefined,
        panel: tagsPanel,
      },
      {
        id: 'hide-done',
        label: filter.hideDone ? 'Show done' : 'Hide done',
        icon: filter.hideDone ? EyeOff : Eye,
        pressed: filter.hideDone,
        onSelect: () => setFilter((f) => ({ ...f, hideDone: !f.hideDone })),
      },
      newTask,
    ],
    // The panels close over the filter and the labels; the items are memoised
    // because a change of identity restarts the menu's layout pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter, labels.join('\n')],
  )

  return (
    <MorphingMenu
      ref={menu}
      label="Board"
      anchor="bottom-center"
      surface="float"
      items={items}
      className="pointer-events-auto"
    />
  )
}
