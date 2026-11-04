/**
 * The History's search field and its filter menu (docs/features/agent-sessions.md,
 * The Agents view), over the state in `../state/session-list`.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
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
import { historyFocusAtom } from '../state/agents-view'
import { startViewSessionAtom } from '../state/session-view'

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

/** MonoCode's search field with its filter button, as a ReUI input group.
 *  It is the History's launcher too (⌘J focuses it): typing narrows the
 *  sessions, ↓ goes into them, and Enter starts a new session with what was
 *  typed as its first prompt. */
export function SessionSearch(): React.JSX.Element {
  const [query, setQuery] = useAtom(sessionQueryAtom)
  const [filter, setFilter] = useAtom(sessionFilterAtom)
  const active = filterActive(filter)
  const start = useSetAtom(startViewSessionAtom)
  const focusAsked = useAtomValue(historyFocusAtom)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusAsked > 0) field.current?.focus()
  }, [focusAsked])
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
        ref={field}
        type="search"
        placeholder="Search, or type a prompt and press Enter…"
        aria-label="Search conversations, or start one"
        spellCheck={false}
        autoComplete="off"
        data-session-launcher=""
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault()
            setQuery('')
          } else if (e.key === 'ArrowDown') {
            // Into the list, where the cards' own arrows take over.
            const card = e.currentTarget
              .closest('[data-agents-history]')
              ?.querySelector<HTMLElement>('[data-session-card]')
            if (card) {
              e.preventDefault()
              card.focus()
            }
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            const prompt = query.trim()
            setQuery('')
            void start(prompt === '' ? {} : { prompt })
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
