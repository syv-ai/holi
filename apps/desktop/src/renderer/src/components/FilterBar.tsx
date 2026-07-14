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
import { availableLabels, filterAtom, tasksAtom, todayAtom } from '../state/tasks'

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
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-900 px-3 py-1.5">
      <input
        value={filter.search}
        onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
        placeholder="search…"
        data-filter-search
        className="w-40 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
      />

      {/* Virtual labels and real tags are one vocabulary — the picker cannot tell them
          apart, and neither should the user. */}
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((tag) => {
          const on = filter.tags.includes(tag)
          return (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              data-filter-tag={tag}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                on
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {tag}
            </button>
          )
        })}
      </div>

      <label className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
        <input
          type="checkbox"
          checked={filter.hideDone}
          onChange={(e) => setFilter((f) => ({ ...f, hideDone: e.target.checked }))}
          data-filter-hidedone
        />
        hide done
      </label>
    </div>
  )
}
