/**
 * The History's search field and its filter menu (docs/features/agent-sessions.md,
 * The Agents view), over the state in `../state/session-list`.
 */
import { useAtom } from 'jotai'
import { ListFilterIcon, SearchIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
import { cn } from '@/plugin-api'
import {
  filterActive,
  NO_FILTER,
  sessionFilterAtom,
  sessionQueryAtom,
  type SessionFilter,
  type SessionSource,
} from '../state/session-list'

const STATE_FILTERS: readonly {
  value: SessionFilter['states'][number]
  label: string
}[] = [
  { value: 'needs-you', label: 'Needs you' },
  { value: 'working', label: 'Working' },
  { value: 'done', label: 'Done' },
]

const SOURCES: readonly { value: SessionSource; label: string }[] = [
  { value: 'all', label: 'Anyone' },
  { value: 'mine', label: 'You' },
  { value: 'agents', label: 'Holis and automations' },
]

/** MonoCode's search field with its filter button, as a ReUI input group. */
export function SessionSearch(): React.JSX.Element {
  const [query, setQuery] = useAtom(sessionQueryAtom)
  const [filter, setFilter] = useAtom(sessionFilterAtom)
  const active = filterActive(filter)
  const toggleState = (value: SessionFilter['states'][number]) =>
    setFilter((f) => ({
      ...f,
      states: f.states.includes(value) ? f.states.filter((s) => s !== value) : [...f.states, value],
    }))
  return (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder="Search conversations…"
        aria-label="Search conversations"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault()
            setQuery('')
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <InputGroupButton
              size="icon-xs"
              aria-label={active ? 'Filter, on' : 'Filter'}
              data-filter-on={active ? '' : undefined}
              className={cn('relative', active && 'text-foreground')}
            >
              <ListFilterIcon aria-hidden="true" />
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute end-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                />
              )}
            </InputGroupButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>State</DropdownMenuLabel>
            {STATE_FILTERS.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={filter.states.includes(s.value)}
                onCheckedChange={() => toggleState(s.value)}
                onSelect={(e) => e.preventDefault()}
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Started by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filter.source}
              onValueChange={(v) => setFilter((f) => ({ ...f, source: v as SessionSource }))}
            >
              {SOURCES.map((s) => (
                <DropdownMenuRadioItem
                  key={s.value}
                  value={s.value}
                  onSelect={(e) => e.preventDefault()}
                >
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={filter.archived}
              onCheckedChange={(v) => setFilter((f) => ({ ...f, archived: v === true }))}
              onSelect={(e) => e.preventDefault()}
            >
              Show archived
            </DropdownMenuCheckboxItem>
            {active && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setFilter(NO_FILTER)}>
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </InputGroupAddon>
    </InputGroup>
  )
}
