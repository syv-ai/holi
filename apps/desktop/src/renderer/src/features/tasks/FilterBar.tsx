/** The board's only narrowing (prd/tasks.md §Board UX).
 *
 * **Three controls, deliberately:** text search, tag filter, done toggle. Nothing else.
 * The bar is a search-and-narrow aid, not a second configuration surface — no
 * overdue-only, no priority-only, no recurrence-window, no date buckets.
 *
 * It does not need them: `overdue` and `p1`/`p2`/`p3` are *labels* (D41), so they sit in
 * the tag picker beside real tags and "show me the overdue p1s" is an ordinary tag
 * query. That is what computing the labels buys.
 */
import { useAtom, useAtomValue } from 'jotai'
import { Button, Checkbox, Input } from '@/primitives'
import { cn } from '@/lib/cn'
import { availableLabels, filterAtom, tasksAtom, todayAtom } from '@/state/tasks'

export function FilterBar(): React.JSX.Element {
  const [filter, setFilter] = useAtom(filterAtom)
  const tasks = useAtomValue(tasksAtom)
  const today = useAtomValue(todayAtom)

  const labels = availableLabels(tasks.values(), today)

  const toggleTag = (tag: string) =>
    setFilter((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
      <Input
        value={filter.search}
        onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
        placeholder="search…"
        data-filter-search
        className="h-8 w-40 text-xs"
      />

      {/* Virtual labels and real tags are one vocabulary — the picker cannot tell them
          apart, and neither should the user. */}
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((tag) => {
          const on = filter.tags.includes(tag)
          return (
            <Button
              key={tag}
              variant="outline"
              size="xs"
              onClick={() => toggleTag(tag)}
              data-filter-tag={tag}
              className={cn(
                'text-[10px]',
                on && 'border-primary bg-primary/10 text-brand hover:bg-primary/15 hover:text-brand',
              )}
            >
              {tag}
            </Button>
          )
        })}
      </div>

      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          checked={filter.hideDone}
          onCheckedChange={(v) => setFilter((f) => ({ ...f, hideDone: v === true }))}
          data-filter-hidedone
        />
        hide done
      </label>
    </div>
  )
}
