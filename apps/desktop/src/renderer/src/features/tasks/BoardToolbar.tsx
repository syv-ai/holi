/**
 * The board's toolbar (docs/features/tasks.md): a row across its top, in the
 * panel header's style. Search, Filter and View narrow what the board shows;
 * New task opens quick add.
 *
 * **Still three narrowing controls, deliberately:** search, filter, and View's
 * Show done. The filter holds the folders that have tasks, the people tasks
 * are assigned to, and the tags. `overdue` and `p1`–`p3` are labels, so they
 * sit in the tag list beside real tags and "the overdue p1s" is an ordinary
 * tag query. What the filter narrows by shows as chips beside it, each one's ✕
 * taking it off.
 */
import { hasLogin, sameLogin } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AtSign, Folder, ListFilter, Plus, Search, Settings2, X } from 'lucide-react'
import { PanelHeader } from '@/composites'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/primitives'
import { nowAtom } from '@/state/clock'
import { peopleList } from '@/state/members'
import { sessionAtom } from '@/state/session'
import {
  ROOT_LANE,
  availableLabels,
  filterAtom,
  laneOf,
  laneOrder,
  openQuickAddAtom,
  tasksAtom,
  togglePerson,
} from '@/state/tasks'

/** Labels are drawn bare, as on a card; a real tag carries its `#`. */
const VIRTUAL = new Set(['overdue', 'p1', 'p2', 'p3'])
const tagName = (tag: string) => (VIRTUAL.has(tag) ? tag : `#${tag}`)
const folderName = (folder: string) => (folder === ROOT_LANE ? 'Vault root' : folder)
const personName = (login: string) => `@${login}`

type FilterList = 'folders' | 'people' | 'tags'

/** A checkbox row that leaves the menu open, so several can be picked. */
const keepOpen = (event: Event) => event.preventDefault()

export function BoardToolbar(): React.JSX.Element {
  const [filter, setFilter] = useAtom(filterAtom)
  const openQuickAdd = useSetAtom(openQuickAddAtom)
  const tasks = useAtomValue(tasksAtom)
  const now = useAtomValue(nowAtom)
  const labels = availableLabels(tasks.values(), now)
  const lanes = [...tasks.values()].map(laneOf)
  const folders = laneOrder(lanes).filter((l) => l !== ROOT_LANE || lanes.includes(ROOT_LANE))
  const me = useAtomValue(sessionAtom)?.login ?? null
  // Everyone some task is assigned to, the signed-in person first.
  const people = peopleList(
    [...tasks.values()].flatMap((t) => t.assignees),
    me,
  )

  const toggle = (kind: 'folders' | 'tags', value: string) =>
    setFilter((f) => ({
      ...f,
      [kind]: f[kind].includes(value) ? f[kind].filter((v) => v !== value) : [...f[kind], value],
    }))
  const remove = (kind: FilterList, value: string) =>
    setFilter((f) => ({ ...f, [kind]: f[kind].filter((v) => v !== value) }))
  const chips = [
    ...filter.folders.map((value) => ({
      kind: 'folders' as const,
      value,
      name: folderName(value),
    })),
    ...filter.people.map((value) => ({ kind: 'people' as const, value, name: personName(value) })),
    ...filter.tags.map((value) => ({ kind: 'tags' as const, value, name: tagName(value) })),
  ]

  return (
    <PanelHeader className="gap-2">
      <InputGroup className="h-8 w-56">
        <InputGroupAddon>
          <Icon icon={Search} size="sm" />
        </InputGroupAddon>
        <InputGroupInput
          value={filter.search}
          placeholder="Search tasks"
          aria-label="Search tasks"
          data-filter-search
          onChange={(event) => setFilter((f) => ({ ...f, search: event.target.value }))}
        />
        {filter.search && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label="Clear search"
              onClick={() => setFilter((f) => ({ ...f, search: '' }))}
            >
              <Icon icon={X} size="sm" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>

      {/* The folders that hold tasks (the vault root only when some do), the
          people tasks are assigned to (when any are), then the tags. A folder
          or a person matches any chosen; a tag must be on the task. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Filter">
            <Icon icon={ListFilter} size="sm" />
            Filter
            {chips.length > 0 && <Badge variant="secondary">{chips.length}</Badge>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-96 w-60">
          {folders.length > 0 && <DropdownMenuLabel>Folders</DropdownMenuLabel>}
          {folders.map((folder) => (
            <DropdownMenuCheckboxItem
              key={folder || '/'}
              checked={filter.folders.includes(folder)}
              data-filter-folder={folder}
              onSelect={keepOpen}
              onCheckedChange={() => toggle('folders', folder)}
            >
              <Icon icon={Folder} size="sm" />
              {folderName(folder)}
            </DropdownMenuCheckboxItem>
          ))}
          {people.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>People</DropdownMenuLabel>
            </>
          )}
          {people.map((login) => (
            <DropdownMenuCheckboxItem
              key={login}
              checked={hasLogin(filter.people, login)}
              data-filter-person={login}
              onSelect={keepOpen}
              onCheckedChange={() => setFilter((f) => togglePerson(f, login))}
            >
              <Icon icon={AtSign} size="sm" />
              {me !== null && sameLogin(login, me) ? `${login} (you)` : login}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Tags</DropdownMenuLabel>
          {labels.length === 0 && (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">No tags yet</p>
          )}
          {labels.map((tag) => (
            <DropdownMenuCheckboxItem
              key={tag}
              checked={filter.tags.includes(tag)}
              data-filter-tag={tag}
              onSelect={keepOpen}
              onCheckedChange={() => toggle('tags', tag)}
            >
              {tagName(tag)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <Icon icon={Settings2} size="sm" />
            View
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem
            checked={!filter.hideDone}
            onCheckedChange={(show) => setFilter((f) => ({ ...f, hideDone: !show }))}
          >
            Show Done
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {chips.map(({ kind, value, name }) => (
          <Button
            key={`${kind}:${value}`}
            variant="secondary"
            size="xs"
            aria-label={`Stop filtering by ${name}`}
            data-filter-chip={value}
            onClick={() => remove(kind, value)}
            className="font-normal"
          >
            {name}
            <Icon icon={X} size="sm" />
          </Button>
        ))}
      </div>

      <Button size="sm" onClick={() => openQuickAdd()}>
        <Icon icon={Plus} size="sm" />
        New task
      </Button>
    </PanelHeader>
  )
}
