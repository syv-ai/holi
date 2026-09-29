/**
 * The board's controls: one dock floating at its foot (docs/features/tasks.md),
 * the nav menu's morph (`MorphingMenu`, `bottom-center`). At rest four icons;
 * each grows the dock into what it does.
 *
 * **Still three narrowing controls, deliberately:** search, filter, hide done.
 * The filter holds the folders that have tasks and the tags. `overdue` and
 * `p1`–`p3` are labels, so they sit in the tag list beside real tags and
 * "the overdue p1s" is an ordinary tag query. The fourth icon is quick add,
 * which is not a filter.
 */
import { useAtom, useAtomValue } from 'jotai'
import { Eye, EyeOff, Folder, ListFilter, Plus, Search, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import {
  Button,
  Icon,
  IconButton,
  Input,
  MorphRow,
  MorphingMenu,
  type MorphingMenuHandle,
  type MorphingMenuItem,
  instant,
  settle,
} from '@/primitives'
import { nowAtom } from '@/state/clock'
import {
  ROOT_LANE,
  availableLabels,
  filterAtom,
  laneOf,
  laneOrder,
  quickAddAtom,
  tasksAtom,
} from '@/state/tasks'
import { QuickAdd } from './QuickAdd'

/** Labels are drawn bare, as on a card; a real tag carries its `#`. */
const VIRTUAL = new Set(['overdue', 'p1', 'p2', 'p3'])
const tagName = (tag: string) => (VIRTUAL.has(tag) ? tag : `#${tag}`)
const folderName = (folder: string) => (folder === ROOT_LANE ? 'Vault root' : folder)

/**
 * What the filter is narrowing by, floating just above the dock while it
 * narrows: one chip per folder, then per tag, each one's ✕ taking it off.
 * Nothing at rest.
 */
export function FilterChips(): React.JSX.Element {
  const [filter, setFilter] = useAtom(filterAtom)
  const reduced = useReducedMotion() ?? false
  const chips = [
    ...filter.folders.map((value) => ({ kind: 'folders' as const, value })),
    ...filter.tags.map((value) => ({ kind: 'tags' as const, value })),
  ]
  const remove = (kind: 'folders' | 'tags', value: string) =>
    setFilter((f) => ({ ...f, [kind]: f[kind].filter((v) => v !== value) }))
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      <AnimatePresence initial={false} mode="popLayout">
        {chips.map(({ kind, value }) => {
          const name = kind === 'folders' ? folderName(value) : tagName(value)
          return (
            <motion.div
              key={`${kind}:${value}`}
              layout={!reduced}
              initial={{ opacity: 0, scale: 0.8, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={reduced ? instant : settle}
            >
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Stop filtering by ${name}`}
                data-filter-chip={value}
                onClick={() => remove(kind, value)}
                className="h-8 gap-2 rounded-full bg-muted pr-3.5 pl-5 text-xs has-[>svg]:pr-3.5 has-[>svg]:pl-5 font-normal text-foreground active:scale-100 hover:bg-accent dark:hover:bg-accent"
              >
                {kind === 'folders' && (
                  <Icon icon={Folder} size="sm" className="text-muted-foreground" />
                )}
                {name}
                <Icon icon={X} size="sm" className="text-muted-foreground" />
              </Button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

const newTask: MorphingMenuItem = {
  id: 'new',
  label: 'New task',
  icon: Plus,
  rise: true,
  panel: (close, open) => <QuickAdd flight open={open} onAdded={close} />,
}

export function BoardDock(): React.JSX.Element {
  const [filter, setFilter] = useAtom(filterAtom)
  const [quickAdd, setQuickAdd] = useAtom(quickAddAtom)
  const tasks = useAtomValue(tasksAtom)
  const now = useAtomValue(nowAtom)
  const labels = availableLabels(tasks.values(), now)
  const lanes = [...tasks.values()].map(laneOf)
  const folders = laneOrder(lanes).filter((l) => l !== ROOT_LANE || lanes.includes(ROOT_LANE))
  const narrowing = [...filter.folders.map(folderName), ...filter.tags.map(tagName)]
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

  /** The filter's two lists: the folders that hold tasks (the vault root
   *  only when some do), then the tags. A folder matches any chosen; a tag
   *  must be on the task. */
  const filterPanel = (): ReactNode => {
    const toggle = (kind: 'folders' | 'tags', value: string) =>
      setFilter((f) => ({
        ...f,
        [kind]: f[kind].includes(value) ? f[kind].filter((v) => v !== value) : [...f[kind], value],
      }))
    const heading = (text: string) => (
      <p data-morph-row="" className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">
        {text}
      </p>
    )
    return (
      <div className="flex w-60 flex-col gap-0.5">
        {folders.length > 0 && heading('Folders')}
        {folders.map((folder) => (
          <MorphRow
            key={folder || '/'}
            icon={Folder}
            label={folderName(folder)}
            on={filter.folders.includes(folder)}
            data-filter-folder={folder}
            onClick={() => toggle('folders', folder)}
          />
        ))}
        {heading('Tags')}
        {labels.length === 0 && (
          <p data-morph-row="" className="px-2.5 py-1.5 text-sm text-muted-foreground">
            No tags yet
          </p>
        )}
        {labels.map((tag) => (
          <MorphRow
            key={tag}
            label={tagName(tag)}
            on={filter.tags.includes(tag)}
            data-filter-tag={tag}
            onClick={() => toggle('tags', tag)}
          />
        ))}
      </div>
    )
  }

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
        id: 'filter',
        label: narrowing.length ? `Filter: ${narrowing.join(', ')}` : 'Filter',
        icon: ListFilter,
        pressed: narrowing.length > 0 || undefined,
        panel: filterPanel,
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
    [filter, labels.join('\n'), folders.join('\n')],
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
