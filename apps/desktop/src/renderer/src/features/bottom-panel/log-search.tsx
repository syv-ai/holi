import { type ReactNode } from 'react'
import { useAtom, type PrimitiveAtom } from 'jotai'
import { ListFilterIcon, SearchIcon, XIcon } from 'lucide-react'

import { Badge } from '@/components/reui/badge'
import { Filters } from '@/components/reui/filters/filters'
import { type FilterOperatorLabels } from '@/components/reui/filters/filters-operators'
import { countFilterRules, createFilterQuery } from '@/components/reui/filters/filters-query'
import {
  type FilterField,
  type FilterQuery,
  type FilterValueDisplayContext,
} from '@/components/reui/filters/filters-types'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/cn'

/** Option rows draw the value's own face, keeping the plain label only for
 *  search and the accessible name. */
export const FACE_MENU =
  '[&_[data-slot=filter-menu-icon]]:text-foreground [&_[data-slot=filter-menu-icon]+span]:sr-only'

/** Badge faces take the 32px row a select item gives them, not the 28px text row. */
export const BADGE_MENU = `${FACE_MENU} [&_[role=option]]:min-h-8`

/** The first chosen value's face, then +N for the rest. */
function FirstFacePlus({
  values,
  face,
  empty,
}: {
  values: string[]
  face: (value: string) => ReactNode
  empty: string
}) {
  const [first] = values
  if (first === undefined) return <>{empty}</>
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="flex min-w-0">{face(first)}</span>
      {values.length > 1 ? (
        <Badge variant="outline" className="shrink-0 tabular-nums">
          +{values.length - 1}
        </Badge>
      ) : null}
    </span>
  )
}

export const faceValue = (face: (value: string) => ReactNode, empty: string) =>
  function FaceValue({ values }: FilterValueDisplayContext) {
    return <FirstFacePlus values={values.map(String)} face={face} empty={empty} />
  }

/** Short operator words keep the builder's rows narrow. */
const COMPACT_OPERATORS: FilterOperatorLabels = {
  is_not: 'is not',
  is_any_of: 'any of',
  is_none_of: 'none of',
  not_contains: 'excludes',
  starts_with: 'starts with',
  empty: 'empty',
  not_empty: 'not empty',
}

/**
 * A log tab's search, in the panel header (docs/features/status-bar.md): the
 * Agents sidebar's search field (`SessionSearch`) with the filters inside it.
 * The filter button opens ReUI's Filters builder inline in a popover, every
 * rule a row; once a rule is set, a count and a clear-all sit beside it.
 */
export function LogSearch({
  searchAtom,
  queryAtom,
  fields,
  placeholder,
  label,
}: {
  searchAtom: PrimitiveAtom<string>
  queryAtom: PrimitiveAtom<FilterQuery>
  fields: FilterField[]
  placeholder: string
  /** The field's accessible name. */
  label: string
}) {
  const [search, setSearch] = useAtom(searchAtom)
  const [query, setQuery] = useAtom(queryAtom)
  const count = countFilterRules(query)
  const rules = `${count} ${count === 1 ? 'filter' : 'filters'}`

  return (
    <InputGroup className="w-72">
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && search !== '') {
            e.preventDefault()
            setSearch('')
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        {count > 0 ? (
          <>
            <Badge
              variant="primary-light"
              radius="full"
              className="tabular-nums"
              aria-label={`${rules} applied`}
            >
              {count}
            </Badge>
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear filters"
              onClick={() => setQuery(createFilterQuery())}
            >
              <XIcon aria-hidden="true" />
            </InputGroupButton>
          </>
        ) : null}
        <Popover>
          <PopoverTrigger asChild>
            <InputGroupButton
              size="icon-xs"
              aria-label={count > 0 ? `Filter, ${rules}` : 'Filter'}
              className={cn(count > 0 && 'text-foreground')}
            >
              <ListFilterIcon aria-hidden="true" />
            </InputGroupButton>
          </PopoverTrigger>
          {/* The builder stops clicks at its edge. React bubbles them
              through the portal to the input group's addon, which focuses
              the search field on any click; Radix reads that focus as
              outside and closed the builder the moment an attribute was
              picked. */}
          <PopoverContent
            align="end"
            aria-label="Filters"
            className="w-144 max-w-(--radix-popover-content-available-width)"
            onClick={(e) => e.stopPropagation()}
          >
            <Filters
              fields={fields}
              query={query}
              onQueryChange={setQuery}
              variant="advanced"
              advancedMode="inline"
              size="sm"
              operatorLabels={COMPACT_OPERATORS}
            />
          </PopoverContent>
        </Popover>
      </InputGroupAddon>
    </InputGroup>
  )
}
