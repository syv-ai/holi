/**
 * Search, Filter, Sort and New task across the top of Board, List and Table,
 * the view's one New task.
 * One toolbar and one filter for the three, so switching tab keeps what the
 * person narrowed to. A tab's own controls (List and Table's group toggle,
 * Table's Display) ride in `extra`. It spans the tab as a bar of its own,
 * and `PanelBody` (`panel-body.tsx`) holds what it narrows.
 */
import type { ReactNode } from 'react'
import type { Priority } from '@holi/shared'
import { ArrowUpDownIcon, FilterIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'

import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import {
  EMPTY_PLANNING_FILTER,
  isFiltered,
  PLANNING_SORTS,
  PRIORITIES,
  type PlanningFilter,
  type PlanningSort,
} from '@/lib/planning'

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  return on ? (list.includes(item) ? [...list] : [...list, item]) : list.filter((x) => x !== item)
}

export function PlanningToolbar({
  filter,
  onFilterChange,
  sort,
  onSortChange,
  people,
  tags,
  onNewTask,
  extra,
}: {
  filter: PlanningFilter
  onFilterChange: (filter: PlanningFilter) => void
  sort: PlanningSort
  onSortChange: (sort: PlanningSort) => void
  /** Everyone a task can be filtered by. */
  people: readonly string[]
  tags: readonly string[]
  onNewTask: () => void
  extra?: ReactNode
}) {
  const active = filter.people.length + filter.tags.length + filter.priorities.length
  const priorities: { id: Priority | 'none'; name: string }[] = [
    ...PRIORITIES,
    { id: 'none', name: 'No priority' },
  ]

  return (
    <div className="border-border flex shrink-0 flex-col gap-3 border-b px-4 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-6">
      <InputGroup className="w-full min-w-0 lg:max-w-xs">
        <InputGroupAddon align="inline-start">
          <SearchIcon className="text-muted-foreground size-4" aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          value={filter.search}
          onChange={(event) => onFilterChange({ ...filter, search: event.target.value })}
          placeholder="Search tasks…"
          aria-label="Search tasks"
        />
        {filter.search.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => onFilterChange({ ...filter, search: '' })}
            >
              <XIcon className="size-4" aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <FilterIcon data-icon="inline-start" aria-hidden="true" />
              Filter
              {active > 0 ? (
                <Badge variant="outline" className="tabular-nums">
                  {active}
                </Badge>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Priority</DropdownMenuLabel>
              {priorities.map((priority) => (
                <DropdownMenuCheckboxItem
                  key={priority.id}
                  checked={filter.priorities.includes(priority.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    onFilterChange({
                      ...filter,
                      priorities: toggled(filter.priorities, priority.id, checked === true),
                    })
                  }
                >
                  {priority.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            {people.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Assignee</DropdownMenuLabel>
                  {people.map((login) => (
                    <DropdownMenuCheckboxItem
                      key={login}
                      checked={filter.people.includes(login)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) =>
                        onFilterChange({
                          ...filter,
                          people: toggled(filter.people, login, checked === true),
                        })
                      }
                    >
                      {login}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </>
            ) : null}
            {tags.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Tags</DropdownMenuLabel>
                  {tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag}
                      checked={filter.tags.includes(tag)}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) =>
                        onFilterChange({
                          ...filter,
                          tags: toggled(filter.tags, tag, checked === true),
                        })
                      }
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </>
            ) : null}
            {active > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    onFilterChange({
                      ...filter,
                      people: [],
                      tags: [],
                      priorities: [],
                    })
                  }
                >
                  Reset filters
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <ArrowUpDownIcon data-icon="inline-start" aria-hidden="true" />
              Sort: {PLANNING_SORTS.find((s) => s.id === sort)?.name ?? 'Manual'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => onSortChange(value as PlanningSort)}
            >
              {PLANNING_SORTS.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {option.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {extra}

        {isFiltered(filter) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onFilterChange(EMPTY_PLANNING_FILTER)}
          >
            Clear
          </Button>
        ) : null}

        <Button type="button" size="sm" onClick={onNewTask}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          New task
        </Button>
      </div>
    </div>
  )
}
